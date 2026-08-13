# Part 15 — External Forms

Everything in Parts 1–14 assumes a form runs *inside* the app: an iframe in
`case.html`, a parent relaying `apiSend`, a logged-in staff member. External
forms are the other half — the same template, the same renderer, served to a
member of the public over an unauthenticated link.

Design contract: `ref/EXTERNAL_FORMS_DESIGN.md`. This chapter is the operational
version of it.

---

## Visibility — the three tiers

Whether a template may be served externally lives in a **column**
(`form_templates.visibility`), not in the definition. Policy is policy;
the definition is content.

| Value | External routes serve it? | Use |
|-------|---------------------------|-----|
| `internal` *(default)* | No — nothing at all | Staff forms |
| `portal` | Portal credential only | Client portal (future slice) |
| `public` | Anyone with the link | Intake, lead capture |

Set it in the **Form Builder** — the small select beside the version badge in
the editor header (the list view shows a coloured badge on any template that
isn't `internal`). It calls `POST /api/form-templates/:id/visibility`.

Two rules worth internalising:

- **Visibility is a separate act from publishing.** Flipping a template to
  `public` does not publish it, and publishing does not change visibility. The
  external routes serve the **published** definition only — so a template can
  sit at `public` with `definition IS NULL` and serve nothing until you publish.
- **Flipping *off* `internal` is refused** while the published definition
  carries anything in the refusal list below. Flipping *back* to `internal` is
  always allowed.

## The refusal invariant

A published definition carrying any of these is **refused** on external
surfaces — never stripped, never partially served:

| Refused | Why |
|---------|-----|
| `code` | Arbitrary JS execution |
| `css` | Arbitrary style injection |
| `hooks` | Arbitrary JS execution |
| any `type: "embed"` field | Third-party iframe on a public page |

`hooks: null` and empty strings scan clean — only a real value trips it.

The scan runs **on every external request**, not just at the moment you flip
visibility, because publishing can change the definition after the flip. It
also runs at publish time: publishing a definition with a refused key onto a
non-internal template succeeds but returns `external_refusals`, and the builder
warns that external requests are now 404ing until you publish a clean
definition or set visibility back to `internal`.

**A refused template is indistinguishable from a template that does not
exist.** Missing, unpublished, wrong visibility, and refused all return the
same generic 404 with the same body. That is deliberate — the external surface
is not an oracle for which form keys exist.

---

## The public link — `GET /f/:form_key`

The SMS-friendly entry point. It redirects to the renderer and nothing else:

```
GET /f/intake?case_id=ABC12345&src=facebook
  → 302 /forms/render.html?form_key=intake&ext=1&case_id=ABC12345&src=facebook
```

- **form_key is shape-gated** against `^[a-z0-9_]{1,50}$` before it is embedded
  anywhere. A bad shape gets the generic 404 **without touching the database** —
  the route stays oracle-free by never querying at all. Existence, visibility,
  and refusal are the API's call one hop later.
- **Every query param is forwarded** except the four the route and renderer own:
  `form_key`, `ext`, `preview`, `template_id`. `case_id` rides through, and so
  does any staff-declared `urlParam`.
- **Repeated params are forwarded in order.** The renderer's rule is last-wins.
- **Nested query shapes (`a[b]=c`) are dropped** — nothing consumes them.

`preview` and `template_id` are stripped because forwarding them let a public
URL flip the renderer into the authed preview boot, which then died on "must run
inside the app". No data leak, but a confusing dead end reachable from outside.

---

## `case_id` — the credential

External forms are unauthenticated by design. The credential is the `case_id`
bearer param in the URL — the same pattern document requests and intake links
have always used.

**What happens when it's absent, malformed, or unknown** depends on
`external.badLink` in the definition:

| `badLink` | Behaviour |
|-----------|-----------|
| `"reject"` *(default)* | 404 with `badLink: true`; renderer shows the standing Unauthorized-Link copy |
| `"degrade"` | Form renders anonymously; prefill is `null`, submission is unlinked |

Absent and malformed land identically — the response never confirms which.

**When it resolves**, the payload carries a hard three-field projection of the
case's Primary contact:

```
contact_name · contact_phone · contact_email
```

That is the whole read. Not a subset of a wider query — a deliberate ceiling.
If the case has no Primary, prefill is `null` and the form still renders. Any
broader `contacts.*` read reaching this path is a defect: `contact_ssn` is on
that table.

> **Pick `degrade` deliberately.** It is right for an ad landing page where
> most visitors have no case yet. It also means a *mistyped* `case_id` produces
> a silently unlinked submission rather than an error — the client fills in the
> whole form and it lands unattached.

---

## Prefilling from the URL — `urlParam`

Any top-level field can declare a URL parameter that prefills it:

```json
{ "name": "src", "type": "hidden", "urlParam": "src" }
```

Then `?src=facebook` fills it. Rules, all enforced at publish:

| Rule | Detail |
|------|--------|
| Shape | `^[a-zA-Z0-9_-]{1,50}$` |
| Unique | One field per param name, form-wide |
| Top-level only | Not inside repeaters — one param can't address N rows |
| Not on `embed` | Embeds carry no value |
| Not reserved | See below |

**Reserved names** (`URL_PARAM_RESERVED`, `services/formTemplateService.js`):
`form_key`, `ext`, `preview`, `template_id`, `link_id`, `case_id`,
`contact_id`, `appt_id`.

**Ordering.** URL prefill is applied *after* server, `$load`, and resolver
prefill. Under the default `prefillMode: "ifEmpty"` the server data wins and the
param only fills gaps. Declare `prefillMode: "always"` for param-wins.

**Edge behaviour.** Duplicate params: the **last** wins (not the first —
`URLSearchParams.get()` returns the first, which is why the renderer uses
`getAll().pop()`). Empty values are ignored. A value that matches no option on a
select or radio silently doesn't stick.

This is what replaced per-channel form keys: one `intake` form with `?src=`
rather than `intake_fb`, `intake_google`, `intake_radio`.

---

## After submit — `external.postSubmit`

Without it, an external submit behaves like an internal one: a toast, form stays
editable. That's right for staff and wrong for a member of the public, who needs
a terminal state.

```json
"external": {
  "badLink": "degrade",
  "postSubmit": {
    "message": "Thank you! We look forward to speaking with you.",
    "edit": true,
    "new": false
  }
}
```

| Key | Type | Effect |
|-----|------|--------|
| `message` | string ≤ 2000 | Thank-you copy. Rendered via `textContent` — no markup |
| `edit` | boolean | Show a button returning to the filled form |
| `new` | boolean | Show a button reloading for a fresh submission |
| `redirect` | string ≤ 2000 | **(X3.3)** Navigate here after submit instead of showing the panel — `message`/`edit`/`new` are ignored when set. A same-origin path (`/p/thank-you`) or an absolute `https://` URL. Landing pages are the intended target |
| `redirectBack` | boolean | **(X3.3)** Append the submitted form's URL as `?b=…` so the landing page can render its own "Edit your response" link. **Same-origin-path redirects only** — the back URL carries the case credential and is never sent off-origin (publish rejects the combination) |

```json
"postSubmit": {
  "redirect": "/p/intake-thanks",
  "redirectBack": true
}
```

The back URL is the **top frame's** URL when the frame chain is same-origin —
a visitor who filled the form inside the branded `/p/form` host gets the branded
URL back, not the bare renderer URL. The navigation itself targets the top frame
when same-origin (the host page leaves with the form) and stays in-frame under a
cross-origin embed. All template-declared `urlParam` prefills survive the round
trip because `b` preserves the full query string; `b` itself is a reserved
`urlParam` name.

`badLink` is server-only and never reaches the wire. `postSubmit` is the one
`external.*` key the renderer receives, hoisted to the response top level so the
`external` block itself stays off the public definition.

All of `external.*` is editable in the builder under **Form settings → External
rendering** (X3.3 — previously JSON-only).

---

## The branded host page

`/f/intake` renders the form on a bare page — correct, but unbranded, and with
no logo, phone number, or firm context. The **host page** wraps it: a landing
page that carries the LSG chrome and iframes the form.

```
https://app.4lsg.com/p/form?f=intake&case_id=ABC12345&src=facebook
```

One page record hosts **every** public form. Params it owns — consumed, never
forwarded:

| Param | Required | Purpose |
|-------|----------|---------|
| `f` | yes | The `form_key` to host |
| `t` | no | Heading override — needed only on a vanity domain, where the frame's title can't be read cross-origin |

Everything else on the querystring passes through verbatim to `/f/:form_key`,
which then applies its own reserved-param filter. So `case_id`, `src`, and any
declared `urlParam` all survive both hops.

> **Open item:** `f` and `t` are not yet in `URL_PARAM_RESERVED`. Until they
> are, a staff-authored field declaring `urlParam: "f"` publishes cleanly and
> then silently never receives its value on the host page. Verified 2026-08-12:
> no template declares either name — `intake`'s `src` is the only `urlParam` in
> the table. The names are two consts (`P_FORM`, `P_TITLE`) at the top of the
> page's script if the reserved-list call goes the other way.

**Behaviour.**

- **Height.** Same-origin (`app.4lsg.com`) the iframe auto-grows to its content
  and the page scrolls. Cross-origin (a mapped vanity domain) it falls back to a
  viewport-filling iframe that scrolls internally. Both work; no change to
  `render.html` is needed.
- **Title.** `render.html` sets `document.title` but renders no visible heading,
  so the host page lifts the title out of the frame and displays it. Cross-origin
  that isn't readable — pass `t` instead. The heading stays hidden rather than
  showing a placeholder.
- **Post-submit.** When `.ycr-post-submit` appears, the host scrolls to top so
  the thank-you isn't below the fold.
- **Missing or malformed `f`** renders an explanatory panel with the firm's
  phone number, rather than iframing a 404.
- `noindex, nofollow` and `referrer: no-referrer` — the URL carries a bearer
  credential and must not reach a search index or a third-party `Referer`.

**Installing it.** Either home works:

| | Landing-page record | Static file |
|---|---|---|
| Where | pageManager → New Page, slug `form`, status **live** | `public/form.html` |
| URL | `/p/form?f=…` | `/form?f=…` |
| Deploy needed | no | yes |
| Vanity domain | yes (Host/Path fields) | no |

> **The pageManager Preview will show a broken form.** The preview iframe is
> `sandbox="allow-scripts"` with no `allow-same-origin`, so the nested frame
> gets an opaque origin and its `/api/ext` fetch fails CORS (see below). Test on
> the live URL.

---

## Limits and hardening

**No CORS.** `router.use('/api/ext', noCors)` strips the ambient
`Access-Control-Allow-Origin` that `server.js` applies globally. Cross-origin
JavaScript cannot read these responses at all. This is load-bearing, not
tidiness: the wildcard grant turned a 40-bit bearer credential from
unguessable-per-IP into enumerable-by-botnet. **Do not re-add a permissive ACAO
to `/api/ext/*`** without redoing the arithmetic in the entropy note at the top
of `services/extFormService.js`.

**Rate limits** (`lib/rateLimiter`, keyed on `getClientIp` — *not* `req.ip`,
which collapses all external traffic into one bucket behind Cloud Run's proxy
chain):

| Route | Budget |
|-------|--------|
| `GET /api/ext/forms/:form_key` | 30 / 15 min / IP |
| `POST /api/ext/forms/:form_key/submit` | 10 / 15 min / IP |
| `POST …/submit` | 5 / hour / `case_id` |

Per-instance and in-memory — best-effort by design, not a hard guarantee across
Cloud Run instances.

**The submit body is `{ case_id?, values }` and nothing else.** `link_type`,
`link_id`, and workflow ids in the body are exactly the inputs this surface must
never accept. Linkage is resolved from the credential server-side, values are
re-validated server-side against the published definition, and
the `onSubmit` workflow(s) are dispatched server-side from that same
definition. **(X3.4)** `onSubmit.workflows` fires up to 3 workflows per
submission — the shared "Form Submission Notify" workflow rides as one entry
(its `notify_to` / `labels` / `title_field` in that entry's `initData`) and a
form-specific workflow beside it. Each fires independently; one failing never
blocks the others or the submission.

---

## The Form Inbox (X4)

Anonymous submissions (degrade-mode, expired or missing links) land with
`link_type=''` — the **Form Inbox** (index → More → Form Inbox) is the staff
workspace for them. The wf 40 task to RG is the *notification*; the Inbox is
where the work happens:

- **List** — every unlinked submitted row, with a name / phone / email
  preview pulled from the answers. The scope selector switches between
  **Needs linking** (the default), **Linked**, and **All submissions**;
  linked rows show their target and an **Open** button instead of
  **Link…**, and the badge always counts what still needs linking. A second
  selector filters by **class** — the template's `visibility` (internal /
  portal / public), plus *External* for portal+public together and *No
  template* for legacy form keys that have no template row. Class is a live
  property of the template, so reclassifying a form moves its old submissions
  between buckets. Both selectors default to showing everything, and any row
  they hide is announced above the list — a work queue should never drop work
  quietly.
- **View** — the full answers, rendered read-only by the *same renderer* the
  submitter used (`render.html?view_submission=<id>`), under the definition
  version the submission was made against. Nothing on the view can write.
- **Link…** — adopt the submission onto its entity. The picker follows the
  template's `link_type` (the intake is a case-form, so you pick a case).
  Case-forms with a usable name + phone/email also offer **Create contact +
  case…**, which runs the standard find-or-create New Client dialog and links
  to the case it makes.

Linking an **intake** onto a case also stamps `case_intake_form`
(`yf:<submission_id>`) when it's still empty — the same stamp wf 40 writes on
a linked submission — so the strategy-session SMS reminders stop. The adopt
itself is recorded as a `form` log entry on the target, and the submission
row keeps `linked_by` / `linked_at` forever.

Adoption is one-way. Linked submissions never reappear in the Inbox; each
case's **Form Submissions** tab lists everything linked to it (adopted rows
carry an `adopted` badge).

---

## Publishing checklist

1. Build and **publish** the template as normal (Part 14).
2. Confirm the published definition carries no `code`, `css`, `hooks`, or
   `embed` field — otherwise the visibility flip is refused.
3. Set **visibility** to `public`.
4. Choose `external.badLink` — `reject` for links that always carry a real
   `case_id`, `degrade` for anything a stranger might open.
5. Add `external.postSubmit.message` so submitters get a terminal thank-you.
6. Declare a `urlParam` on a hidden field for any attribution you want
   (`src` is the convention).
7. Test the bare link: `/f/<form_key>?case_id=…`.
8. Test the branded link: `/p/form?f=<form_key>&case_id=…`.
9. Test the **no-`case_id`** case — it behaves differently per `badLink` and is
   the one people forget.

---

## See also

- **Part 13** — publish/versioning, `apiColumn`, prefill, hooks routing
- **Part 14** — the Form Builder, including the visibility control
- **Subsystems → Landing Pages** — hosting the branded wrapper
- `ref/EXTERNAL_FORMS_DESIGN.md` — the design contract this implements