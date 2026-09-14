# Rider D — `?c=` is a raw contact_id: quantified, optioned, YOUR call

**No patch in this program. This page is the deliverable.** 2026-08-17.

## The defect, restated at its real size

| Surface | Credential shape |
|---|---|
| Booking | `contacts.booking_token` — 32-hex bearer |
| Manage  | `appts.appt_manage_token` — 32-hex bearer |
| **Video** | **raw sequential `contacts.contact_id`** |

Consequences, descending certainty (all re-verified against HEAD + live DB):

1. **Live:** `video_views.contact_id` is forgeable — walk `?c=1,2,3…` and
   video analytics attribute to arbitrary contacts. (Rider C's 30/min/IP
   limiter now makes bulk enumeration slow, but does not make it wrong-proof.)
2. **Live:** `{{c}}` substitutes the id into outbound action URLs, so an
   enumerated id rides to whatever the action targets. **Mitigating fact
   found this program: zero actions are configured on any of the 17 videos**,
   so this path is currently cold.
3. **Latent:** `access_level='contact_only'` gates on "the id resolves in
   `contacts`" — defeated by guessing any valid id. All 17 videos are
   `public` today; this arms the first time the tier is used. **The Rider-B
   indexability decision is coupled here**: `/v/` stayed indexable *because*
   `?c=` is not a credential — if it becomes one, `/v/` must join
   `isCredentialedPath` in the same slice.

## Blast radius of changing the parameter (queried, not guessed — 2026-08-17)

**Link minters (forward-looking; what a change must touch):**
- 3 `sequence_steps` rows (60, 81 — template 19; 83 — template 20), all
  `send_sms` bodies with `?c={{contacts.contact_id}}`. These are the ONLY
  live templates.
- 0 `workflow_steps`, 0 `app_settings`, 0 `pages`, 0 `videos.description/actions`.
- Frontend copy-buttons: `videoManager.html` (copy-for-contact + both embed
  builders), `js/videoInsert.js` `buildUrl`, `sendingform-bk.html` `irs_idme`
  — all just repointed to the landing host in Rider B; a token switch edits
  the same handful of lines again.

**Links already in flight (what a hard cutover would break):**
- 17 `log` rows carrying `/v/…?c=` (sent SMS/email), **≤12 unique contacts**,
  window 2026-05-04 → 2026-08-13. Most recent send is 4 days old.
- Campaigns: 104 (sent, app-host `/v/` link, **no** `?c=`) and 105 (sent, a
  `localhost:8080` URL — already broken; test artifact).
- Actual usage: `video_views` has **50 rows all-time, 16 in the last 30
  days**. Attribution is a feature the firm barely exercises yet.

Bottom line: the in-flight population is a dozen contacts over three months.
This is close to the cheapest moment there will ever be to change the shape.

## Options

**A. Dual-accept, deprecate the integer** — accept `?ct=<token>` alongside
`?c=<int>`; all minters switch to `?ct=`; `?c=` hits log a deprecation line.
+ Nothing sent ever breaks; no drain window to manage; `contact_only`
  becomes honest the day minters switch.
− Two code paths live indefinitely; enumeration of the *legacy* param keeps
  working until you consciously kill it (set a calendar note, or gate
  `contact_only` to token-only from day one — recommended hybrid).
Cost: ~small slice. Route param handling + 3 SQL REPLACEs + the frontend
minter lines + tests.

**B. Token-only, hard cutover** — switch everything to `?ct=`; `?c=` dies.
+ One code path; enumeration dead immediately.
− Breaks up to 17 sent links / ≤12 contacts (they'd land on the video with
  no attribution if you drop the param silently, or 404 if you 400 it —
  choose "ignore unrecognized `?c=`" and even this option only loses
  *attribution*, never the video itself). Honestly, with `?c=` ignored
  rather than rejected, B ≈ A-without-the-legacy-path.
Cost: same slice as A minus the dual path.

**C. Leave `?c=` as attribution; token only for `contact_only`** — accept
that public-video analytics are best-effort; add `?ct=` solely as the
`contact_only` gate when that tier is first used.
+ Zero work now; zero link breakage ever.
− Forgeable analytics forever; the `{{c}}` downstream ride persists; someone
  must remember the coupling when `contact_only` is first used (this note is
  the only guard).

**Token choice, either way:** reusing `contacts.booking_token` is free (row
already exists per contact) but means one leaked video link also carries
booking-prefill identity. A dedicated `contacts.video_token` costs one
migration and keeps the credentials' blast radii separate. With attribution
being this low-stakes, reuse is defensible; separation is cleaner. Flag it
when you charter.

## My read (you decide)

**B with "ignore unknown `?c=`" semantics** — i.e. mint `?ct=` everywhere,
treat a bare/unknown `?c=` as anonymous — gets you the honest shape at the
cost of losing attribution on ≤12 mostly-stale links, with no permanent
second code path. If losing even that attribution bothers you, A's hybrid
(dual-accept, but `contact_only` honors tokens only) is the same work plus
one deprecation logline. C is only right if you decide video attribution is
permanently a toy.
