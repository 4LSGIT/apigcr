# Charter — pageLanding POST limiter keying (the last holdout)

**Status: chartered, not built. 2026-08-17.**

**Provenance note, honestly:** the 2026-08-17 video-landing program was told
this charter already existed ("`CHARTER_pageLanding_limiter.md`… covers
`routes/pageLanding.js`") and to "fold the video route in". **The file did
not exist anywhere in the repo** — the "charter" was one sentence in
`lib/rateLimiter.js`'s header ("chartered, not fixed here") and a bullet in
`ref/ORIGIN_SEPARATION_ROLLOUT.md`. This file is that charter, written for
real. The video route was NOT folded in — it was fixed directly in the same
program (see "What already happened" below), which leaves `pageLanding.js`
as the **single** remaining holdout.

## What already happened (2026-08-17, shipped separately)

`routes/videoLanding.js` — the worse of the two holdouts, because
`GET /v/:slug` is an unauthenticated **write** (INSERT per hit) with **no
limiter of any kind** — got fixed inline rather than chartered:

- `makeLimiter` + `getClientIp` from `lib/rateLimiter.js`; GET 30/min/IP
  (matches the booking/manage read limit), POST beacons 30/min/IP shared.
- Its private **first-XFF** `getClientIp` copy was deleted. That copy also
  fed `videoService.hashIp`, so view dedup and per-IP analytics were
  spoofable; they now key on the GFE-appended last element. Accepted
  behavior change: `ip_hash` values for the same client differ across the
  deploy boundary.
- Sizing was checked against 30 days of real `video_views` (16 views, max
  2/IP/hour) — the limits are >800× observed peak.
- Test-locked in `tests/videoLanding.rateLimit.test.js`, including the
  rotating-first-XFF-element bypass staying in one bucket.

Why inline there but chartered here: the video route had **no** limiter
(adding one cannot regress live behavior), while pageLanding has a live,
working anti-spam limiter whose only defect is its key. Swapping a key on a
live protection during an unrelated routing slice is exactly the kind of
silent behavior change this program keeps getting burned by.

## The remaining defect

`routes/pageLanding.js` carries an inline fixed-window limiter (10 POSTs /
min) for landing-page form submissions, keyed on:

```js
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}
```

Both halves are wrong on this chain (see `lib/rateLimiter.js`'s doc block,
evidence dated 2026-08-05):

- **`cf-connecting-ip`** — there is no Cloudflare in front of any host here
  (every landing host is a direct Cloud Run domain mapping; verified again
  2026-08-16 in the rollout note). The header is client-suppliable, so an
  attacker sends a fresh value per request and gets a **fresh bucket per
  request** — the limiter rate-limits everyone except attackers.
- **`req.ip` fallback** — resolves to constants for external traffic on this
  chain (verified in `portal_access_log`), collapsing all honest traffic
  into **one global bucket**: one busy marketing campaign can rate-limit
  every visitor at once.

So today's limiter is simultaneously bypassable by attackers and
over-aggressive against legitimate bursts. Note the blast radius is bounded:
the limiter guards only the landing-page **POST** path (form submits), drops
are silent-303 by contract, and the honeypot still works independently.

## The fix (small, but it changes live anti-spam behavior)

1. Delete the inline `clientIp`, `rateLimited`, `rlBuckets`, and the sweep
   interval from `routes/pageLanding.js` (~25 lines).
2. `const { makeLimiter, getClientIp } = require('../lib/rateLimiter');`
   `const postLimited = makeLimiter(60 * 1000, 10);` — same window, same max.
3. `handleSubmit`: `if (postLimited(getClientIp(req)))` → same silent-303
   drop path, unchanged contract.
4. The `_ip` field in the hook envelope **also** comes from `clientIp()`
   today. Decide whether it moves to `getClientIp` too. Recommendation: yes
   — hook filters keyed on `_ip` currently see a spoofable value — but
   **check first** whether any live hook filter/mapper references `_ip`
   (query `hooks` configs) so nothing silently changes meaning.
5. Update the stale sentences in `lib/rateLimiter.js`'s header and the
   rollout note's "Deliberately not done" bullet, which will then be wrong.

## Tests

Extend `tests/pageLanding.originsep.test.js` or a small sibling:
- 11th POST in a minute from one (last-XFF) IP → still 303, hook NOT called.
- Rotating `cf-connecting-ip` per request does NOT mint fresh buckets.
- Rotating the first XFF element does NOT mint fresh buckets.
- Two distinct last-XFF peers → independent buckets.

## Sizing check before shipping

Run the same volume check the video slice ran: landing-page POST volume over
30 days (hook_executions for landing-page hooks, or `log`/form submissions).
10/min/IP was chosen blind in the original slice; confirm it clears the
busiest legitimate burst observed (multiple people submitting from one
office/CGNAT IP during a campaign) before keeping it.

## Rollback

One commit, no data migration. Revert restores the inline limiter exactly;
nothing external depends on the key shape.
