# EXTERNAL_FORMS_DESIGN — X2 amendments (2026-08-11)

For the supermanager ledger. Fred ratified both; forms manager implemented in
X2. Paste §A into EXTERNAL_FORMS_DESIGN.md as §5.2.4, and record §B/§C as
ledger notes. Repo + tests are already the source of truth
(tests/extForms.x2.test.js, tests/formRender.x2External.test.js).

---

## §A — new §5.2.4: `urlParam` prefill (amends "server resolves everything")

Staff may declare, per field, a URL query param that prefills it
(`"urlParam": "src"` → `?src=facebook`). Ratified rationale: an anonymous
submitter already controls every submitted value, so a param-fed prefill
carries zero privilege — it is a field value supplied earlier, not a
credential. The inversion rule is untouched: params never name load URLs,
never reach link resolution, never hit the server before submit.

Rules (validateDefinition-enforced, test-locked):
- Token shape `^[a-zA-Z0-9_-]{1,50}$`; empty/absent = not allowed (default).
- RESERVED names rejected — the params the route/renderer consume:
  `form_key, ext, preview, template_id, link_id, case_id, contact_id,
  appt_id`. The credential is never shadowable by a prefill declaration.
- Unique form-wide; top-level value-carrying fields only (not repeaters, not
  embeds).
- Ordering: server `$load` projection first, URL params after, honoring the
  field's `prefillMode` (`ifEmpty` default → server data wins, params fill
  gaps; `always` → param wins). Same write helper as every prefill
  (mask/date normalization; select/radio values matching no option don't
  stick — a URL never injects an unlisted option).
- Repeated params in one URL: the LAST wins (deliberate `getAll().pop()`;
  native `.get()` is first — test-locked against "simplification").
- Works in internal AND external render modes (`/f/:form_key` forwards all
  params). Convention, not enforcement: never used for sensitive values —
  the builder help text says so; the 3-field server projection already
  covers identity prefill, so nothing needs PII in a URL.
- Consequence: distinct-form_keys-per-channel is no longer needed for
  source attribution (a hidden `src` field + `?src=` covers it).

## §B — §5.3.7 RG alert: deferred from X2 to X3 (deliberate deviation)

The route-level "office alert to user 22 via the existing alerting path" is
NOT hardcoded in the X2 submit route. §7 already charters the intake
template's onSubmit.workflow to wire the RG alert for the anonymous branch;
a route-level duplicate would double-notify, and §5.3.7's "existing alerting
path" was an unresolved open question (lib/alerting is the ops channel —
wrong audience). The workflow channel owns it; X3 wires it. If the
supermanager wants a template-independent backstop for ALL unlinked
submissions, that is a small X4 (Form Inbox) rider once the alerting path is
named.

## §C — §5.4 rate limiting: implemented as written, against the boot-prompt correction

lib/rateLimiter (makeLimiter + getClientIp) now exists — the portal arc
built it after the 2026-08-07 verification that flagged §5.4 as naming
nonexistent helpers. Its getClientIp (last XFF element) is the correct key
on this chain: req.ip yields constants for external traffic (verified
2026-08-05, portal_access_log), so express-rate-limit keyed on req.ip — the
correction's prescription, and the pattern on the public checklist routes —
collapses all external traffic into one global bucket. X2 uses the portal
pattern: GET 30/15min/IP, POST 10/15min/IP, plus 5/hr per VALID case_id
(bucket space bounded by real cases). The checklist routes' limiter keying
is pre-existing debt, noted, not in forms-arc scope.

## §D — minor implementation facts worth the ledger

- External GET serves an ALLOWLIST projection of the published definition:
  endpoints, onSubmit, apiColumn, resolver prefill expressions, optionsFrom
  (firmData paths), `note` (staff commentary), and `external` never reach
  the public wire. Not §4 stripping — refused templates never get this far;
  this is information-disclosure hygiene, allowlisted so future server-side
  keys stay private by default.
- External submit success body is `{ status: 'success' }` only — sequential
  submission ids are a volume oracle not worth handing out.
- badLink-reject responses carry `badLink: true` on the generic 404 body.
  The flag fires only after every template gate passed, so it reveals only
  that a public form exists under that key — which its public link already
  reveals. It never distinguishes wrong vs missing case_id (test-locked).
- External drafts: localStorage-only per §5.3.8, reusing the existing
  banner/restore/version-warning machinery via the same record shape.
  Server drafts and /api/forms/latest are never touched externally
  (test-locked live in jsdom).
- onSubmit.workflow dispatch reuses lib/internal_functions.start_workflow
  (the existing wf→wf creation path: active check, contact resolution,
  capture arm, detached advance) — a fifth creation site was not minted.
  initData mirrors the internal client's assembly byte-for-byte: values →
  config initData → system fields win.


---

# X2.1 — corrective slice (2026-08-12), from the §9 co-review

Co-review verdict: SHIP WITH CONDITIONS. All four blocking conditions are
closed below, plus every should-fix and every actionable note. Full jest:
2902 passing / 1 pre-existing skip.

## §E — CREDENTIAL ENTROPY (F1). Supersedes any "48-bit" claim anywhere.

The external bearer credential is **40 bits**. `lib/caseId.js` mints 8 chars
of Crockford Base32 (32 symbols) via `generateCaseId()`. The ~1k legacy
mixed-case base64url ids are ~42 bits **as the DB sees them** —
`cases.case_id` is `utf8mb4_general_ci`, so the collation folds case.
`caseId.js`'s "40 bits is ample" reasons about COLLISION (birthday bound);
X2 depends on the different property of ONLINE-GUESSING resistance, derived
now: P(hit/guess) ≈ 1075/2^40 ≈ 9.8e-10 → ~1.0e9 expected guesses. Per-IP
that is unreachable (~350k IP-days at 30 GET/15min).

The prior "48-bit crypto-random" figure in §2 and in `extFormService.js`
came from the X2 boot prompt and described code at a path that does not
exist. It was never re-derived against `lib/caseId.js`. Corrected in code
with the arithmetic inline. **§2 of EXTERNAL_FORMS_DESIGN.md should be
amended to say 40 bits** — supermanager action.

**CORS revoked on `/api/ext/*`** (`api.ext.forms.js`, `noCors`). `server.js`
applies `cors({origin:'*'})` globally, which let any web page read these
responses from a visitor's browser — turning per-IP-unreachable into
botnet-reachable (~1M hijacked browsers ⇒ a hit inside a day, every per-IP
bucket intact), each hit yielding a bankruptcy client's name, phone, email.
Removing the header beats naming an origin: nothing legitimate is
cross-origin (SMS flow is same-origin via `/f/`; a website embed is an
iframe of that same page). Do not restore a permissive ACAO without redoing
this arithmetic.

## §F — ReDoS acceptance is now bounded, not accepted (F6)

Staff-authored `pattern` regexes run against attacker-controlled input up to
`maxLength` — or 20000 when the field declares none. Nested quantifiers
would stall the single-threaded instance for every user. Inputs longer than
`REGEX_INPUT_CAP` (512) now fail the pattern without being run through it.
No legitimate patterned form value is 512+ chars; failing closed is the safe
direction.

## §G — `linked` flag / §5.2-§6 contradiction (F2): FORMS-MANAGER POSITION

The reviewer is right that §6's "never confirms whether the case_id was
real" is false as implemented, and right that removing the flag would be
illusory (`resolveCase` issues 0/1/2 queries for malformed/unknown/valid —
a timing oracle far larger than the flag). Adding: the case-existence oracle
has **zero marginal security value to an attacker**. Confirming a case_id
exists is strictly weaker than what the same request already returns on
success (the PII payload), and in reject mode the 200-vs-404 split is the
same signal. An attacker's enumeration rate is identical with or without it.

Recommended resolution: **amend §6's wording, change no code.** §6's real
guarantee — the one that holds and is worth keeping — is that the ERROR
COPY does not distinguish malformed from unknown from missing. Suggested
text: "the badLink response is identical for a malformed, unknown, or
absent case_id; note that a successful load necessarily confirms the id
resolved, and that enumeration is bounded by the credential entropy (§2) and
the CORS posture, not by response shape." Supermanager's call.

## §H — F7 fix: the CORRECT binding, not the contained patch

`resolveCase` now also selects `contact_id` (internal sidecar, stripped
before the wire) and the submit route passes it as `contact_id_override` to
`start_workflow`. Precedence there is override > `init_data[workflow's
default_contact_id_from]` > NULL, so this both binds executions to the real
Primary contact (what X3's workflow wants anyway) and closes the latent hole
where a public submitter controlled the value of a declared field whose NAME
matched that workflow's `default_contact_id_from`. Anonymous submissions
pass no override and bind to nothing.

**§5.2.3 wording:** the reviewer reads "hard three-field projection" as
governing THE WIRE, not the query. The forms manager agrees — and the wire
guarantee is now test-locked (`contact_id` asserted absent from the GET
payload). The ban on `contacts.*` / `SELECT *` is unchanged: every column is
still named explicitly, so `contact_ssn` stays unreachable. Recommend §5.2.3
be amended to say "three fields on the wire". Supermanager action.

## §I — remaining X2.1 changes

- **F4 (blocker):** anonymous external drafts moved to `sessionStorage`
  (`_draftStore()`). The `…:anon` localStorage key was a single shared slot
  for every anonymous visitor on a device — and anonymous is the NORMAL path
  for a degrade-mode intake form, so visitor 2 was offered a Restore button
  for visitor 1's bankruptcy answers. Linked drafts stay in localStorage
  (per-case key, client's own device, surviving a restart is the point).
- **F5:** the 64KB cap moved off `Content-Length` (absent under chunked
  encoding, so it passed unconditionally) onto the parsed payload inside
  `validateValues`. Per-field caps do not bound the total: 100 repeater items
  x N fields x 20000 chars is a multi-megabyte payload every field-level rule
  accepts. Separately, the per-case limiter now runs AFTER validation — it
  was a lockout weapon (five malformed POSTs from any link holder, or five
  honest client mistakes, locked the real client out for an hour). Five VALID
  submissions still exhaust it; that residue is inherent to per-case capping
  and is indistinguishable from a real client submitting.
- **N1:** `/f/` strips `preview` and `template_id` (renderer mode switches);
  credential params still ride through. **N3:** `no-store` on every branch.
  **N4:** external mode can never take the authed load-URL fallback.
  **N6:** option objects projected to `{value,label}` only — the one nested
  spot the allowlist previously stopped short of. **N8:** `form_key` shape
  gate on the API route, matching `/f/`.
- **Tests:** +18. New `tests/f_route.x21.test.js` (gap 2 — the route had none).
  Anonymous draft store both ways (gap 4). Status codes in the no-oracle test
  (gap 5). Limiters now locked, including "a 400 does not consume the
  per-case token" (gap 1). F7 binding + `contact_id` absent from the wire
  (gap 6). Payload cap, ReDoS timing, option projection.

## §J — accepted, not fixed (with reasons)

- **N2** (repeated `case_id` degrades a valid link): the strict
  `typeof === 'string'` gate is the right posture; an array-valued credential
  should not resolve. Real links carry one `case_id`.
- **N5** (`$load` shape differs internal vs external): real. External
  `_loadResult` is flat `{contact_name, contact_phone, contact_email}`;
  internal is the API payload keyed by `endpoints.load.path`. A template
  therefore cannot prefill in both modes. X3's intake template is
  external-only, so this does not bite now — **but it must be recorded as an
  X3 authoring constraint**, and §5.2.4's "no new prefill vocabulary" is
  loose as written.
- **N7** (anonymous submissions share one `MAX(version)` bucket): fine at
  intake volumes; the index covers the prefix. Revisit before high volume.
- **N9** (`tests/ formrender.x2external.test.js` — leading space in the
  filename, recorded that way in TRACKED_FILES.txt): introduced by the commit
  pipeline, not the source. Jest matches it, so it runs, but it is a landmine
  for any tooling shelling out with an unquoted path. **Fred: rename.**
  Note the same pipeline lowercases test filenames.
- **Test-gap 7** (repeater `required`/`requiredWhen` not enforced
  server-side): genuine spec ambiguity — §5.3.2 does not say, and the client
  does not enforce them inside repeaters either, so server enforcement would
  reject submissions the renderer considers complete. Left as-is
  deliberately; flag to the supermanager if repeater-level requirement is
  wanted.
## §K — X3/X3.3: `external.postSubmit` (ratified amendments, recorded 2026-08-13)

**X3 (Fred-ratified 2026-08-12), recorded here retroactively** — the amendment
originally landed only in code + manual ch.15; `ref/FORM_TEMPLATE_SCHEMA_V1.md`
was left stale until 2026-08-13. `external.postSubmit { message ≤2000,
edit:bool, new:bool }` is the external renderer's terminal thank-you state;
absent = pre-X3 behavior byte-identical. Hoisted to the GET response top level;
the `external` block stays off the public definition wire; `badLink` stays
server-only.

**X3.3 (Fred-ratified 2026-08-13)** — `postSubmit` gains:

- `redirect` (string ≤2000): navigate after submit instead of the panel.
  **Supersedes** `message`/`edit`/`new` (ignored when set). Target must be a
  same-origin path (`"/…"`, not `//`-relative, no backslash) or an absolute
  `https://` URL. The template is SU-published content — the URL is trusted
  authorship, not an open redirect. Landing pages (`/p/:slug`) are the
  intended target: chrome stays in the pages system (X3.2 triage), never in
  form definitions.
- `redirectBack` (bool): append the submitter's current URL as `?b=…` so the
  landing page renders its own "Edit your response" link. **Refused unless
  `redirect` is a same-origin path** — the back URL carries the 40-bit case
  credential (§E) and must never ride to an off-origin target's
  logs/analytics/referrer chain. Enforced in `validateDefinition` AND
  re-guarded in the renderer before appending. `b` joined
  `URL_PARAM_RESERVED` (`f`/`t` convention; a form can itself be another
  form's redirect target). Verified before reserving: no live template
  declares `urlParam:"b"`.
- Back URL = `window.top.location.href` when readable (a `/p/form`-framed
  visitor gets the branded URL back), else own URL. Navigation targets the
  top frame when the chain is same-origin, else stays in-frame —
  deterministic under Chrome's cross-origin-top-nav intervention, and
  relative paths resolve against the RENDERER's origin per spec (entry
  settings object), so `/p/…` always lands on the app host even from a
  vanity-domain embed.
- Considered and declined: base64ing the back URL ("surface obfuscation") —
  atob-transparent, changes nothing about what leaks, adds a decode contract
  to every consuming landing page. The path-only rule is the actual control.
- Builder: new **Form settings → External rendering** group (badLink select +
  full postSubmit editor) — `external.*` was previously JSON-only.
  `serializeModel()` already round-trips unmanaged keys, so existing
  definitions stay byte-identical until edited.

## §L — X3.4: `onSubmit.workflows` + share links + /p/submitted (2026-08-13)

**Ratified.** Multiple workflows per submission: `onSubmit.workflows` (1–3
`{id, initData?}` entries) beside the legacy singular (mutually exclusive;
legacy stays valid — byte-identical round-trip for every stored definition).
Every entry fires with the same assembly — values as base, that ENTRY's
initData overriding, system fields + `_values` (external) winning — from BOTH
dispatchers: yc-forms save() step 5 (one internal loop, the arc's first
yc-forms change since X2) and the external route (F7 contact binding applied
to every dispatch). Rationale for the per-entry design over Fred's floated
"default form workflow" app_setting: wf 40's `notify_to`/`labels`/
`title_field` config is per-form and rides the entry's initData — the
workflow itself has NO defaults (step 2 sends to `{{notify_to}}` bare), so an
ambient setting-fired default couldn't carry the config that makes it work.
First-time validation of the legacy `workflow` shape rode along (positive-int
id; live data verified safe: only intake=40 and 341_notes=7 exist; a stored
id-0 was always dead config).

**WF40 GENERICNESS FLAG (open, for Fred):** wf 40 is *not* yet safe as the
shared default across forms — step 6's log subject is "Intake questionnaire
received" and step 7 stamps `case_intake_form` unconditionally. A second form
firing wf 40 on a linked case would falsely mark intake complete. Before
reuse: condition steps 6–7 on `form_key == "intake"` (evaluate_condition),
or fork the tail. Console snippets staged separately.

**Share links (builder):** Form settings gains a read-only "Share links"
block — direct `/f/<key>`, branded `/p/form?f=<key>`, and the sequence-merge
variant with `case_id={{cases.case_id}}` — copy buttons, per-link purpose
text, and the reserved-param note. Origin from `location.origin`.

**/p/submitted:** generic redirect target for `external.postSubmit.redirect`
(pages system row, Fred-installed). Owns params `type` (headline noun,
authored statically on the redirect URL) and `b` (the X3.3 back-link →
"Edit your response" button). `b` is honored ONLY as a same-origin path or a
same-origin absolute URL — it is craftable by anyone, and the page must not
become a redirect hop or javascript: sink; everything reaches the DOM via
textContent/setAttribute. `noindex` + `no-referrer` metas (b carries the
credential). Headline fallback derives the form key from `f=`/`form_key=`
inside b and prettifies it.
## §M — X4: Form Inbox (2026-08-13)

**Design-doc §8 executed with three Fred-ratified extensions** (all
2026-08-13):

1. **All three link types.** The adopt route accepts `case` / `contact` /
   `appt`, not case-only. The link target TYPE is not a free choice per
   submission: the route enforces the TEMPLATE's `link_type` (a case-form
   cannot land on a contact — 409). Submissions whose form_key has no
   template row (legacy hand-built keys) skip that guard. No ApptPicker
   exists, so the appt UI path is a plain id input.

2. **Adopt side-effects (option b).** Pure linkage was the §8 charter; the
   ratified addition closes the intake-gate trap (an adopted anonymous intake
   would otherwise leave `case_intake_form` empty and sequences 20/22 keep
   nagging the client):
   - a `log` entry (type `form`) on the target records the adopt — written
     via `logService.createLogEntry` directly (this is a STAFF action, not a
     submission-time side-effect, so the workflow-only invariant does not
     apply); best-effort — a log failure warns and never rolls back the
     linkage;
   - `form_key='intake'` + target type `case` → stamp
     `cases.case_intake_form = 'yf:<submission_id>'` **only when currently
     empty** (the additive guard rides the UPDATE's WHERE; mirrors wf40
     step 8 exactly). This is the one EXPLICIT per-form hardcode in the
     route family — kept because re-firing wf40 on adopt would duplicate
     the notify email. Config-able later if a second gated form appears.
   - Re-dispatching `onSubmit.workflows` on adopt was CONSIDERED AND
     REJECTED (duplicate notify; wf40 is not adopt-aware).

3. **Version renumber on adopt.** Anonymous submissions share ONE version
   counter (the `('','')` series in `submitForm`'s MAX+1), so an adopted
   row's old version is meaningless in its new home and can shadow the
   target's real latest in `getLatest`'s `ORDER BY version DESC`. The
   adopted row takes `MAX(version)+1` within the TARGET series — adoption
   makes it the newest submission of that form for that entity.

**Adopt is one-way.** Unlinked → linked only; the UPDATE's WHERE re-checks
`link_type=''` so a concurrent double-adopt loses cleanly (409). No relink /
unlink route — mistakes are a manual SQL fix. `linked_by` comes from the auth
principal, never the request body (test-locked). New columns
`form_submissions.linked_by` / `linked_at`
(ref/2026-08-13_form_submissions_linkage.sql); NULL `linked_by` + non-empty
`link_type` reads as "linked at submit time".

**Submission view = a render.html mode, not a second renderer.**
`?view_submission=<id>` boots from `GET /api/forms/submissions/:id/render`
(submission + definition version-matched server-side: current published when
schema matches, else the NEWEST `form_template_versions` row with that
schema_version, else current flagged `schema_matched:false`). Preview-grade
discipline — no code/hooks/prefill/derive-fill/autosave/save — plus forced
`.yc-readonly` with the toggle hidden, a metadata banner, and `linkId:''` so
the `/api/forms/latest` and entity-load paths stay structurally off (the
stored answers are the only populate source). jsdom-locked, including the
code-not-executed assertion.

**browseSubmissions opt-ins.** `unlinked=1` (the plain `link_type` filter
can't express `''` — it's falsy) and `with_data=1` (the inbox preview needs
name/email/phone). Both absent → the pre-X4 query byte-identical; the
slice-4 "no data bodies by default" lock still holds and is re-asserted.

**Surfaces.** `public/formInbox.html` (index.html more-panel iframe — took
the first placeholder button) lists unlinked submitted rows and hosts the
adopt dialog (CaseAdoptDialog/OrphanAdoptDialog precedents; case-forms with
name+phone/email get a create branch through scripts.js `newContact`, whose
onSuccess payload is discriminated by `case_relate` — present only on the
/api/intake/case response). `public/forms/submissionsWidget.html`
(`?link_type&link_id`, case.html "Form Submissions" lazy tab) lists an
entity's submitted rows with the same view modal; adopted rows carry an
"adopted" badge from `linked_by`.

**wf40 state correction (verified in prod 2026-08-13):** the intake-stamp
gate flagged in §L is ALREADY LIVE — steps are renumbered with
`evaluate_condition form_key == "intake"` at step 7 and the stamp at step 8,
and step 6's subject carries `{{log_subject|default:…}}`. The §L warning is
therefore historical. (2026-08-13: the planned ref/X3_4_WF40_SNIPPETS.md file
was dropped — the live DB and this record are authoritative; nothing remains
outstanding.)

**§M addendum (same day, post-review):** the Inbox is scoped, not
unlinked-only — `browseSubmissions` gained `linked=1` (inverse of `unlinked`;
both together is a 400 rather than a silent empty list) and the page has a
Needs linking / Linked / All selector defaulting to the §8 behavior. Linked
rows are read-only there (adopt is one-way) and offer Open instead of Link.
Three defects caught in review and fixed before deploy: (1) the case.html
Form Submissions tab had been placed inside `#bkButtons`, hiding it on every
non-BK case — exactly where an adopted anonymous intake tends to land, since
the type is often unset at submit time; it belongs in the standard
`#caseButtons` bar, which `applyCaseType` never touches. (2) Both new pages
resolved the shell through `window.top.apiSend` while ALSO re-exposing
`window.apiSend` for the render.html view iframe (which reads
`window.parent.apiSend`) — opened standalone, that relay finds itself and
recurses until the stack blows; the lookup is now `window.parent` guarded by
`!== window`. (3) The create-branch discriminated on `case_relate` to decide
whether `newContact` made a case, but that key is present only on the
"Add & Open Case" path: the client path with a Case Type chosen also creates
a case and returns the CONTACT result, so the fallback's "no case was
created" could be false. It now reopens the adopt dialog with the picker
seeded by the submitter's name (`/api/cases/search` matches primary-contact
name) instead of asserting anything.

**§M addendum 2 (2026-08-13, post-adopt review):** two Inbox changes after the
first live adopt. (1) The adopt dialog now renders the chosen target instead
of leaving the picker's search text on screen — `CasePicker` deliberately does
not write the selected row back into its input ("caller owns input state for
cases") and clears its dropdown on click, so a successful pick was invisible
even though Link worked. The picked case/contact is shown as a confirmation
line (who it belongs to, then case#/id/type/stage) with a Change button; the
picker stays mounted underneath so Change restores the previous query. The
appt path keeps its plain id input — there the typed id IS the visible
selection. (2) A class filter over the template's `visibility` enum
(internal | portal | public) with an *External* grouping for portal+public and
a *No template* bucket for the 58 prod submissions whose form_key has no
template row. Note visibility is a single enum — "portal + public" is a filter
grouping, matching how extFormService gates on a scopes ARRAY, not a fourth
value. Both selectors default to unfiltered and any hidden rows are counted
above the list: the Inbox is a work queue, so a filter that silently drops a
submission is the one failure mode worth engineering against.

---

## §N — X5: submission → PDF (`render_submission_pdf`) (2026-08-14)

**Supermanager charter (2026-08-13) executed with one Fred override and two
context corrections.**

1. **OVERRIDE — non-case submissions FILE, they don't ERROR.** The charter's
   "the function requires a linked submission — unlinked submissions have no
   case home; return a clear error" was rejected by Fred (2026-08-14): the
   requirement existed only for save-location, and the e-sign filing ladder
   already solved save-location for entities without a case folder. Ruling:
   case-linked → `<case folder>/Forms/` (rung 2 `ensureCaseDropboxFolder` +
   staff task; rung 3 the unsorted client-uploads bin in the per-case
   subfolder + a post-upload move-task); contact/appt/unlinked → the unsorted
   bin as a loose file with an e-sign-style identity prefix (`contact 12 -
   Jane Doe - `, `appt 45 - `, `submission 288 - <guessed submitter name> - `)
   and **no task** — the Form Inbox already surfaces unlinked submissions, so
   a task per anonymous PDF would duplicate that signal. This also keeps a
   shared onSubmit workflow with a PDF step from failing on every anonymous /
   degrade-mode submission.

2. **Context corrections to the charter (recorded, not merely applied):**
   the ruling's "portal arc's shared fallback ladder" pointed at
   `uploadTargetService` (client temp-UPLOAD links); the operative precedent
   for filing a server-side buffer is `esignFilingService`'s ladder, which is
   what X5 mirrors. And the "signature-excluded like `note`" comparison named
   a doc-only property; the operative display-only-type precedent is `embed`.

3. **What the PDF shows (Fred Q5):** exactly what the submitter saw —
   version-matched definition via `getSubmissionForRender`, `showWhen`
   evaluated server-side with the renderer's exact semantics (checkbox →
   `'true'/'false'`, checkgroup CSV, ops `eq/neq/in/notEmpty/includes`,
   array = AND), option labels, mask display formats, Yes/No checkboxes,
   visible-but-blank = "—", `hidden`/`embed` omitted,
   `schema_matched:false` → a visible layout note. Two deliberate deviations:
   row columns flatten to a label/value list (print reliability), and a
   visible section whose every field is hidden is skipped rather than
   printing a stray heading.

4. **Mechanics:** filename `{prefix}{YYYY-MM-DD} {form title} (#{id}).pdf`,
   date = **created_at** in firm TZ (adopt bumps `updated_at`); drafts
   refused; the returned path is the path **Dropbox returned** (autorename
   authoritative); logo = `fe-firm_logo_url` fetched by the app process,
   inlined as a memoized data URI (chromium is network-blocked), text-only
   header on failure; temp link = `files/get_temporary_link` (~4h, no
   permanent ACL — the charter's leak posture), **best-effort** after upload
   (null + warning rather than a retry that re-files). Rung-2 merge-task
   raised at folder-create time (the folder exists and is linked regardless
   of the upload's fate); rung-3 move-task only after the upload lands
   (`uploadTargetService` semantics). Workflow-only (`__meta.workflowOnly`)
   per charter — also load-bearing: renders serialize on the 1GiB container.

5. **Files:** `services/formPdfService.js` (new), `dropboxService.js`
   (+`getTemporaryLink`), `lib/internal_functions/pdf.js`
   (+`render_submission_pdf`), `tests/formpdf.x5.test.js` (27),
   manual `03-YisraFlow/05-internal-functions.md` (new PDF section — also
   closes the pre-existing `parse_pdf` doc gap). No SQL, no routes.

6. **Arc-level notes recorded with this slice:** Phase D (SMS cutover) is
   **deferred with no timeline** (staged SQL stays at
   `ref/2026-08-13_phase_d_sms_cutover.sql`; whoever fires it re-verifies the
   9 sequence_steps rows first), and the supermanager's mid-September
   Jotform-chain retirement condition is **suspended** until Phase D actually
   fires — the chain still carries live traffic.

---

## §O — X5.1: PDF wiring (2026-08-14)

X5 shipped the engine (`render_submission_pdf`) and nothing called it — no
per-form setting, no workflow step, no UI. This slice is the wiring, per
Fred's four rulings 2026-08-14.

1. **The render runs in the WORKFLOW, not the submit route** (Fred ruling 1,
   accepting the pushback). The original sketch was "the form makes the PDF
   and hands it to the wf", which means chromium inside the submitter's
   request — serialized, multi-second, and a Dropbox write in the external
   route, breaking the arc's "workflow is the only side-effect channel"
   invariant. Instead the FLAG travels and the workflow renders: dispatch is
   already fire-and-forget, and `error_policy: ignore` on the render step
   means a PDF failure cannot cost the office its notification email.

2. **`onSubmit.pdf` is a BOOLEAN**, not a config object. Every decision about
   the PDF (filename, placement overrides) belongs to the
   `render_submission_pdf` step config, where a workflow author can see it —
   splitting it across the form builder and the workflow editor would be two
   places to look for one behavior. Both dispatchers (external route,
   `yc-forms` `save()`) inject it as `make_pdf`, **always defined** (true OR
   false) so a gate reads a real variable rather than distinguishing "off"
   from "started some other way", and always from the PUBLISHED definition —
   a submitter sending a `make_pdf` field cannot drive server-side rendering
   (asserted by test: it must sit in the system block of the assign chain).

3. **Form PDFs get their OWN unsorted bin** (Fred ruling 2, his naming):
   `app_settings.dropbox_unsorted_forms_path`, default
   `/  Law Office/   Cases/  Unsorted Form Submissions`. Not the client-uploads
   bin: a client upload is a document the firm asked for and must chase; a
   form PDF is a machine-generated archive of something already recorded.
   Mixing them makes the uploads bin a work queue nobody can trust to be
   empty. `formPdfService` consequently drops its `uploadTargetService`
   dependency entirely — the only thing shared was the per-case subfolder
   NAMING convention, which is three lines over the `_casePrimaryName` helper
   already present.

4. **Download and File are two buttons, not one** (Fred ruling 3). `GET
   …/pdf` renders and hands over bytes with NO Dropbox write and NO task, so
   pressing it repeatedly costs nothing; `POST …/pdf/file` files on the
   ladder and is deliberately non-idempotent (Dropbox autorenames — a
   duplicate is cheap to delete, silently skipping a re-file staff asked for
   is not). Both are on the Form Inbox AND each case's Form Submissions tab
   (`submissionsWidget`). One render path (`renderSubmissionPdf`) backs the
   button, the workflow step and the email attachment, so what staff print is
   byte-identical to what is filed — asserted by test.

5. **`apiSend` gained `opts.responseType`** (`'json'` default, byte-for-byte
   unchanged; plus `'blob'`, `'text'`, `'response'`). Fred's call, and the
   right one: this was the THIRD hand-rolled binary transport
   (`esignActions.esignFetchBinary` / `esignFetchPdf`, and the
   assetManager/videoManager XHR uploads), each a private copy of the auth,
   401-retry and error handling that lives in one place. Blast radius is
   small — `automationManager` and `caseConfigManager` define
   `apiSend(...args)` pass-throughs and the form pages forward `arguments`,
   so index.html holds the only real implementation. The esign helpers still
   work and can migrate opportunistically.

6. **Two live bugs found while verifying, both fixed here:**
   - **wf40 step 6 subject.** `"{{log_subject|default:Form submission
     received}}"`, set 2026-08-13 10:19:43, resolved to `''` on every run —
     every form log in that window has an empty subject (log 64784 =
     submission 288). There is no modifier syntax in the workflow resolver:
     the whole string including the `|` is looked up as one variable name.
     Reverted to `{{log_subject}}` (intake's `initData` always supplied it).
   - **The manual caused it.** `03-YisraFlow/06-variables-templating.md`
     claimed "a workflow step's config is run through *both*" resolvers and
     documented `|default:` without qualification. `lib/workflow_engine.js`
     never requires `resolverService`; the variable pass consumes EVERY
     `{{…}}` token and blanks what it can't resolve, so a `{{table.column
     |modifier}}` in a workflow step is destroyed, not deferred. Chapter 6
     now carries the corrected two-resolver table and the wf40 incident as a
     worked example. Fred's proposed `{{url||default:""}}` would have hit
     exactly this — and is unnecessary: an unresolved placeholder already
     yields `''`, and both mail adapters drop a url-less attachment.

7. **Files:** `services/formPdfService.js` (new bin, `renderSubmissionPdf`
   extraction), `routes/api.forms.js` (+2 routes),
   `services/formTemplateService.js` (`onSubmit.pdf`),
   `routes/api.ext.forms.js` + `public/js/yc-forms.js` (`make_pdf`),
   `public/index.html` (`apiSend`), `public/formBuilder.html` (toggle),
   `public/formInbox.html` + `public/forms/submissionsWidget.html` (buttons),
   `tests/formpdf.x51.test.js` (15) + `tests/formpdf.x5.test.js` (retargeted),
   manual 02/11, 02/15, 03/05, 03/06, and
   `ref/2026-08-14_x51_pdf_wiring.sql`.

---

## §P — X5.1c: the render moved out of the background (2026-08-14)

X5.1 shipped correct and worked in every respect except one: the render
itself failed on real form submissions while succeeding from the staff
button. Diagnosis and fix, recorded because the finding is system-wide.

1. **Cause: Cloud Run CPU throttling, not a broken container.** Workflow
   steps run detached after the response; under request-based billing an
   idle instance gets a sliver of CPU. Evidence: identical code succeeded
   in-request (Form Inbox button, manual re-run, a submission made while
   Fred was actively using the app) and failed on an idle instance — first
   at a 30s chromium launch timeout, then at a 15s navigation timeout. A
   defect does not relocate between stages; starvation does. Corroborating:
   wf40's pure-JS formatter step measured 137ms–3800ms (27x) across runs.

2. **Fix (X5.1c): wf40 step 3 became a `webhook` step calling the app's own
   `POST /api/forms/submissions/:id/pdf/file`** with credential 1 (YisraCase
   Internal). Cloud Run serves that as a real request with a full vCPU, and
   because CPU is allocated per INSTANCE the awaiting background step speeds
   up with it. Zero new code — the route (X5.1), the internal credential,
   the webhook step type and `app_url` all already existed. Verified live:
   execution 9137.

3. **Rejected: instance-based billing** (`--no-cpu-throttling`), which would
   have fixed every background step. Priced against confirmed config (1 vCPU
   / 1 GiB, us-east1, official rates 2026-08-14): CPU $0.000018/vCPU-s +
   memory $0.000002/GiB-s over a 2,628,000-second month = $52.56 gross, less
   the ~$5.22 instance-based free tier (240k vCPU-s / 450k GiB-s) =
   **~$47/month, ~$570/year**, because the 5-minute scheduler ping keeps an
   instance alive 24/7. Current request-based spend on this line is ~$0 (well
   inside the 180k vCPU-s free tier). Declined: only chromium was BROKEN;
   everything else was merely slower. Revisit if background CPU work becomes
   common.

4. **Rejected: retry-then-abort on the step.** Retries run in the same
   throttled context (same starved instance), so they are lottery tickets;
   and `abort` sets terminalFailure, which would kill the execution and lose
   the notification email — the precise outcome `ignore` exists to prevent.

5. **`{{this}}`, not `{{this.output}}`.** For a webhook step the raw result
   is the parsed response body (`job_executor` returns `result.data`) and
   `context.this` is set to it before set_vars resolve. The comment in
   `lib/job_executor.js` claimed `{{this.output.X}}` access was preserved —
   wrong, and corrected in this slice. Production had the answer all along
   (wf16 step 2 `{{this.records.0.result}}`, wf15 step 2
   `{{this.to.0.phoneNumber}}`). Because the route returns the same verdict
   object the internal function does, storing `{"pdf": "{{this}}"}` left step
   4 untouched. This is the SAME failure mode as §O's `|default:` bug — a
   wrong comment, and a resolver that blanks what it cannot resolve.

6. **Also shipped: `pdfRenderService` timeouts.** Launch timeout was never
   set, so it was puppeteer's laptop-tuned 30s default — the exact number in
   the first production failure. Now explicit and env-tunable
   (`PDF_RENDER_LAUNCH_TIMEOUT_MS` 120s, `PDF_RENDER_NAV_TIMEOUT_MS` 60s
   raised from a hardcoded 15s, `PDF_RENDER_PROTOCOL_TIMEOUT_MS` 240s).
   Insurance for cold starts; not a substitute for execution context.

7. **`render_submission_pdf` remains supported and registered.** X5.1c
   changed how wf40 calls it, not whether it exists — an in-process call is
   still correct anywhere the work runs inside a request.

8. **Sweep completed (§O follow-up):** all 222 workflow steps scanned for
   modifier-style `{{x|y}}` placeholders — zero remaining. A second sweep for
   table-style `{{table.column}}` in workflow steps found 7, all in wf37 and
   all false positives (its step 1 is `get_settings` with
   `output_var: "settings"`, so the root is a real variable that merely
   collides with a table name).
