// lib/caseySensitivity.js
//
// Casey v2 S0 — how risky is a route, may Casey propose it, may Casey GET it
// on its own. ONE small ordered table over `METHOD path`; the catalog
// (lib/routeCatalog.js) calls classify() for every route it lists, and the
// loop (S2+) consults the same row before every tool call. Design:
// ref/CASEY_V2_DESIGN.md §4.4 (tiers, defaults), §8.10 (the lists as checked
// against the live routes) and §9 S0 (what the review added).
//
// Tiers (design §4.4):
//   T0  reads Casey runs on its own (staff-class GETs, sql_read, source/docs)
//   T1  ordinary staff writes — one-line card, Approve / Decline
//   T2  sensitive writes — card + warning line + the exact content shown open
//   T3  superuser routes — T2 + "Superuser action" + the elevation prompt
// Defaults when no rule matches: every superuserCheck route is T3; every
// DELETE is at least T2; a path naming a T2 WORD is T2; every other non-GET
// is T1; a GET is T0. An SU GET that Casey may not auto-run is a T3 card.
//
// `proposable` — may `api_write` put this route on a card at all. False for
// anything a staff JWT cannot call (public, key, portal classes), for
// multipart routes (the card carries JSON; a file upload is not JSON), for a
// `router.all` route (a card names one method), for NEVER_PROPOSABLE (the SU
// consoles — arbitrary SQL / HTTP — and their staff-reachable twin /db-jwt
// (retired 2026-11-22; the rule stays so a resurrection is born closed),
// elevation, internal / job-runner / test plumbing, auth, view-as minting,
// webhook receivers, the assistant routes themselves), and for
// SECRET_RETURNING (a route whose RESPONSE is a plaintext secret: a credential
// reveal, a key mint, the Clio login code — a card's result would put the
// secret into the model's context and into casey_messages).
// `autoGet` — may `api_get` run this GET without a card. False for anything
// outside the staff classes, for every SU GET, for SECRET_RETURNING, and for
// NEVER_AUTO_GET (reads that return credential material to a holder, or
// mint sessions). A closed staff GET is not carded either. A non-JSON
// response (PDF, audio, raw bytes) is refused by api_get's content-type
// check, not by a list here. tests/routeCatalog.test.js also scans every
// auto-GET handler's source for secret-decrypting and SQL-forwarding tokens.
//
// The lists are pinned by snapshot in tests/caseySensitivity.test.js — a
// change is a deliberate review, like CTA_FN_DENYLIST.

'use strict';

const STAFF_CLASSES = new Set(['staff', 'staff:can', 'su']);

// Path words that make a write T2 (design §4.4 list, plus the sends the S0
// review found at T1). Matched as a whole literal path segment, or a
// hyphen-joined part of one (`send-sms` carries `send` and `sms`), case-
// insensitively, on the registered route path — never a param, never a
// substring (`/api/userstats` is not `users`).
const T2_WORDS = Object.freeze([
  'send', 'sms', 'mms', 'esign', 'campaigns', 'enroll', 'publish', 'merge',
  'purge', 'bulk', 'batch', 'users', 'api-keys', 'credentials', 'app-settings',
  'email-credentials', 'readonly-keys', 'start', 'test-send', 'test-sms',
  // S0 review: writes that deliver or fire something, missed by the words above.
  'live-test', 'fire-next', 'resume', 'replay', 'test-step',
]);

// Never on a card. Matched against `METHOD path` (the registered Express
// path, e.g. `/api/reports/:id(\d+)`), method-insensitive unless the rule
// names one.
const NEVER_PROPOSABLE = Object.freeze([
  /^\S+ \/admin\/db(\/|$)/,            // SU DB console — arbitrary SQL
  /^\S+ \/admin\/api-tester(\/|$)/,    // SU API tester — arbitrary HTTP
  /^\S+ \/admin\/elevate$/,            // the password step-up itself
  /^\S+ \/db-jwt$/,                    // ran arbitrary SQL on the main pool behind a plain staff JWT (S0 review; route retired 2026-11-22)
  /^\S+ \/internal(\/|$)/,             // internal plumbing + email-test credentials
  /^\S+ \/process-(jobs?|domain-event|hook-execution)(\/|$)/, // job-runner plumbing (Cloud Tasks / cron targets)
  /^\S+ \/mailbox-ingest(\/|$)/,       // ingest worker trigger
  /^\S+ \/test-advance(\/|$)/,         // workflow test harness
  /^\S+ \/workflows\/test-step$/,      // runs one step for real
  /^\S+ \/hooks(\/|$)/,                // webhook receivers
  /^\S+ \/webhooks(\/|$)/,
  /^\S+ \/auth(\/|$)/,                 // login / password reset / validate
  /^\S+ \/login$/,
  /^\S+ \/api\/auth(\/|$)/,            // change-password, update-profile
  /^\S+ \/api\/impersonation(\/|$)/,   // view-as minting and exit
  /^\S+ \/api\/assistant(\/|$)/,       // v1 — Casey does not drive Casey
  /^\S+ \/api\/casey(\/|$)/,           // v2 — same
  /^\S+ \/api\/readonly(\/|$)/,        // session-key surface (key class anyway)
  /^\S+ \/api\/temp(\/|$)/,            // credentialed proxies (key class anyway)
]);

// Routes whose RESPONSE is a plaintext secret. Neither auto-run nor carded:
// the result would reach the model and be stored with the chat. S1 may
// reopen one by redacting its result generically (design §7, open). SU
// routes included — the `su` tier does not exempt a secret (S0 review).
const SECRET_RETURNING = Object.freeze([
  /^\S+ \S*\/reveal$/,                 // /api/credentials/:id/reveal, /api/email-credentials/:id/reveal
  /^POST \/api\/api-keys$/,            // mints a machine key (shown once)
  /^POST \/api\/api-keys\/rotate-internal$/,
  /^POST \/api\/readonly-keys$/,       // mints a session key (shown once)
  /^\S+ \/clio-code$/,                 // the live Clio 2FA login code
]);

// GETs Casey never runs on its own; they become T3 cards (SU) or are closed.
const NEVER_AUTO_GET = Object.freeze([
  /^(GET|HEAD) \/api\/credentials(\/|$)/,
  /^(GET|HEAD) \/api\/api-keys(\/|$)/,
  /^(GET|HEAD) \/api\/readonly-keys(\/|$)/,
  /^(GET|HEAD) \/api\/email-credentials(\/|$)/,
  /^(GET|HEAD) \/internal(\/|$)/,             // /internal/email-test/credentials*
  /^(GET|HEAD) \/api\/impersonation(\/|$)/,   // the view-as user list
  /^(GET|HEAD) \/api\/hooks$/,                // decrypted hook auth for an automations.manage holder (S0 review)
  /^(GET|HEAD) \/api\/hooks\/:id$/,
]);

const SEGMENT_RE = /[^/]+/g;

function pathWords(path) {
  // Route paths carry Express params and regex tails (`:id(\d+)`); only the
  // literal segments count.
  return String(path || '').match(SEGMENT_RE) || [];
}

function hasT2Word(path) {
  const segs = pathWords(path).filter(s => !s.startsWith(':')).map(s => s.toLowerCase());
  const words = new Set(segs.flatMap(s => [s, ...s.split('-')]));
  return T2_WORDS.some(w => words.has(w));
}

function matchesAny(rules, key) {
  return rules.some(re => re.test(key));
}

/**
 * classify({ method, path, authClass, multipart }) →
 *   { tier: 0|1|2|3, proposable: bool, autoGet: bool|null, reason }
 * `method` upper-case; `_ALL` (router.all) is classified as a write and is
 * never proposable (a card names one method).
 * `authClass` is the catalog's class (lib/routeCatalog.js CLASSES).
 * `autoGet` is null for a non-GET (the question does not arise).
 */
function classify({ method, path, authClass, multipart = false }) {
  const m = String(method || '').toUpperCase();
  const key = `${m} ${path}`;
  const isGet = m === 'GET' || m === 'HEAD';
  const staffClass = STAFF_CLASSES.has(authClass);
  const su = authClass === 'su';

  let tier;
  let reason;
  if (su) { tier = 3; reason = 'superuser route'; }
  else if (isGet) { tier = 0; reason = 'read'; }
  else if (m === 'DELETE') { tier = 2; reason = 'DELETE'; }
  else if (hasT2Word(path)) { tier = 2; reason = 'sensitive path word'; }
  else { tier = 1; reason = 'ordinary write'; }

  const never = matchesAny(NEVER_PROPOSABLE, key);
  const secret = matchesAny(SECRET_RETURNING, key);
  let proposable;
  if (!staffClass) proposable = false;
  else if (multipart) proposable = false;
  else if (m === '_ALL') { proposable = false; reason = 'router.all — no card method'; }
  else if (never) proposable = false;
  else if (secret) { proposable = false; reason = 'returns a secret'; }
  else proposable = true;

  let autoGet = null;
  if (isGet) {
    autoGet = staffClass && !su && !never && !secret && !matchesAny(NEVER_AUTO_GET, key);
    // A staff GET Casey may not auto-run is closed, not carded: the result
    // would show the model a secret. An SU GET is a T3 card (tier already 3)
    // unless it is never-proposable or returns a secret.
    if (!autoGet && !su && staffClass) {
      proposable = false;
      if (!never && !secret) reason = 'credential-returning read';
    }
  }

  return { tier, proposable, autoGet, reason };
}

module.exports = {
  classify,
  T2_WORDS,
  NEVER_PROPOSABLE,
  SECRET_RETURNING,
  NEVER_AUTO_GET,
  STAFF_CLASSES,
  _pathWords: pathWords,
};
