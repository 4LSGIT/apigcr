# EXTERNAL FORMS DESIGN — YisraForm Tiers A/B

**Author:** program supermanager. **Date:** 2026-08-10. **Status:** CONTRACT — governs
all work that renders or submits YisraForm templates outside the authed staff frame.
**Home:** `ref/EXTERNAL_FORMS_DESIGN.md`. **Executes in:** the forms arc (slices X1–X4
below), security co-review by the portal manager. Repo beats this doc; verify before
claiming.

Boot context for any session picking this up: `rw_scratch ns=fred k=supermgr_state`
(program decisions), `ns=fred k=formbuilder_build_state` (forms arc),
`ref/FORM_TEMPLATE_SCHEMA_V1.md` (template contract), `ref/YF_PORTAL_INTERSECTION.md`
(v2 — the refusal invariant's origin).

---

## 1. Purpose and v1 target

One external render+submit surface for YisraForm templates, serving both:
- **Tier A (public):** links sent to clients/leads, optionally case-bound via
  `case_id`. v1 target: the intake form replacing Jotform 231710991971158 and the
  `go.4lsg.com → Pabbly → Jotform` chain (which puts PII in the Jotform query
  string; ours will not).
- **Tier B (portal):** the same routes accepting the portal JWT (`aud:'contact'`)
  as a second credential. Portal-mode forms = credential addition, NEVER a second
  render path or route family.

The renderer stays singular: `public/forms/render.html` + `public/js/yc-forms.js`
in `external:true` mode (already a partial stub: direct fetch, skips parent
entityData/postMessage). External mode is completed, not forked.

## 2. Auth contract

Credentials accepted at the external routes, in v1 order of arrival:

| Credential | Tier | Mechanism | Status |
|---|---|---|---|
| `case_id` bearer param | A | **40-bit** crypto-random case_id (`lib/caseId.js` — 8 chars Crockford Base32; legacy mixed-case base64url ids are ~42 bits as the DB sees them, since `cases.case_id` is `utf8mb4_general_ci` and the collation folds case); the incumbent pattern (docReq, old intake link) | v1 |
| none (anonymous) | A | allowed only where the template's badLink mode permits degrade | v1 |
| portal JWT | B | `Authorization: Bearer` with `{sub, aud:'contact', ver}`; verified exactly as `requireAuth('contact')` does (portal_enabled + session_version + portal_live re-check); token's contact scopes which cases may bind | portal-mode slice |
| `form_tokens` table | B+ | the v2.2 sketch (token, form_key, link_type, link_id, expires_at, used) | RESERVED — build only when a form's sensitivity exceeds what case_id-bearer justifies. No table in v1. |

> **Entropy correction (X2.1, 2026-08-12 — §9 co-review F1).** This row previously read
> "48-bit crypto-random (crypto.randomBytes(6) b64url)", describing code that does not
> exist. The real generator is `lib/caseId.js`. The figure is corrected inline above;
> the online-guessing derivation this arc depends on (as distinct from `caseId.js`'s
> collision reasoning) is in `ref/X2_DESIGN_AMENDMENTS.md` §E, along with why
> `/api/ext/*` revokes the globally-applied wildcard CORS grant. Two further §2/§5.2.3/§6
> wording amendments are pending there for the supermanager; only this number was
> corrected in place, because a wrong security parameter in the governing contract is
> load-bearing for anyone who reads §2 without the amendments file.

**The inversion rule (load-bearing):** externally, the server resolves EVERYTHING
from the credential. The client supplies field values and nothing else. No
client-named load URLs, no client-supplied link_type/link_id, no resolver access,
no firmData fetch. The internal model (client names its endpoint and linkId)
inverts exactly wrong for external surfaces.

## 3. Per-template exposure: the `visibility` column

```sql
ALTER TABLE form_templates
  ADD COLUMN visibility enum('internal','portal','public') NOT NULL DEFAULT 'internal';
```

- Enforced SERVER-SIDE at the external routes. `public` serves Tier A (+B);
  `portal` serves Tier B only; `internal` serves nothing externally. Until the
  column exists, an external route serves nothing.
- Policy lives in the COLUMN, not the definition JSON (definition is content).
- Flipping visibility off `internal` is an explicit act in the builder (separate
  from publish), and the server REFUSES the flip while the published definition
  carries any refused key (§4). Refuse, never strip. Flipping back to internal is
  always allowed.
- Publish and visibility are independent: external routes serve the PUBLISHED
  definition only, and only when visibility permits.

## 4. The refusal invariant (inherited, non-negotiable)

External render AND submit REFUSE templates whose published definition carries:
`code`, `css`, `hooks`, or any `type:"embed"` field. Checked at the route on every
request (cheap key-scan of the published definition), not only at flip time —
belt and suspenders, because publish can change the definition after the flip.
Refusal response is a generic 404-equivalent (no oracle about why).

Relaxing any of these for external surfaces requires the on-demand security
review chartered in program state — possibly never. Internal behavior is
unaffected.

## 5. Routes

### 5.1 Link shape
`https://app.4lsg.com/f/<form_key>?case_id=<case_id>` — a tiny route file
(`routes/f.js`, auto-mounts) that serves/redirects to
`render.html?form_key=<k>&case_id=<id>&ext=1`. SMS-friendly, stable, and the
sequence-template edit at cutover is one line. (`/f/:form_key` is two segments —
clears the `/:page` catch-all concern by construction; verify mount order anyway.)

### 5.2 GET /api/ext/forms/:form_key?case_id=
Returns everything the renderer needs in one payload:

```json
{
  "definition": { ...published definition... },
  "load": { "contact_name": "...", "contact_phone": "...", "contact_email": "..." } | null,
  "linked": true|false
}
```

Server steps, in order:
1. Template lookup by form_key: must exist, be published, and have
   visibility='public' (or 'portal'+valid portal JWT). Else generic 404.
2. Refusal scan (§4). Else generic 404.
3. Resolve case_id if present: case exists → Primary contact →
   **hard projection of exactly contact_name, contact_phone, contact_email** —
   never `contacts.*` (contact_ssn is NOT NULL on that table; any wider read is a
   defect). Wrong/dead/absent case_id → badLink handling (§6).
4. `load` is the projection (or null when anonymous). The definition's prefill
   fields reference it via the EXISTING `$load.*` mechanism — external mode feeds
   the server-computed `load` object where internal mode feeds the parent/API
   payload. Design symmetry; no new prefill vocabulary. `optionsFrom: firmData.*`
   is unavailable externally — static `options` fallback (mandated by the schema
   contract: a select never blanks) is what renders.
5. Response is cacheable-never (no-store): prefill is per-case PII.

### 5.3 POST /api/ext/forms/:form_key/submit
Body: `{ case_id?, values }` (+ portal JWT header in portal mode).

1. Same template/visibility/refusal checks as GET.
2. Server-side re-validation of `values` against the PUBLISHED definition:
   required fields, basic type checks, option-membership for selects. Client
   validation exists but counts for nothing externally.
3. Linkage resolved SERVER-SIDE: valid case_id (or portal-JWT-scoped case) →
   `link_type='case', link_id=<case_id>`; anonymous → `link_type='', link_id=''`
   (columns are NOT NULL; empty-string is the unlinked convention — the
   draft_key generated column tolerates it).
4. INSERT form_submissions: status='submitted', schema_version from template,
   submitted_by=NULL (external), data=values.
5. `apiColumn` PATCH is OFF externally — submission JSON only, regardless of what
   the definition declares. (Staff PATCH machinery is a blocklist accepting
   nearly any column; it must never be reachable from here.)
6. `onSubmit.workflow` runs server-side as internal submissions do (this is the
   sanctioned side-effect channel: log entries, sequences, alerts).
7. Unlinked submission → office alert to user 22 (RG) via the existing alerting
   path, in addition to landing in the Form Inbox (§8).
8. External autosave/drafts: localStorage-only in v1 (no server draft identity
   for anonymous users; portal-mode server drafts are a later portal decision).

### 5.4 Abuse controls (both routes)
- `lib/rateLimiter` with `getClientIp` (the proven post-hardening pattern):
  suggest GET 30/15min/IP, POST 10/15min/IP; per-case_id POST cap (e.g. 5/hr)
  to stop link-holder spam.
- JSON body size cap on submit (e.g. 64KB — the intake form is 7 questions).
- Uniform generic 404 for every refusal branch (missing template, wrong
  visibility, refused keys, reject-mode bad link): no enumeration oracle
  distinguishing "no such form" from "form exists but not for you".

## 6. badLink modes

Definition-level key, validated by `validateDefinition` when visibility is not
internal:

```json
"external": { "badLink": "reject" }   // default
"external": { "badLink": "degrade" }  // intake's mode
```

- **reject** (default): invalid/missing case_id → the standing error page text:
  "Unauthorized Link or Client ID — Sorry, the link you followed is unauthorized
  or the client ID is invalid. Please contact us if you believe that this error
  is an error." Rendered by render.html's external error state; API returns the
  generic 404 shape with a flag the renderer maps to that copy.
- **degrade**: invalid/missing case_id → anonymous mode (load=null,
  linked=false); the form works, submission lands unlinked, RG alert fires.
  Never errors PII, never confirms whether the case_id was real.

## 7. Slice X3 — the intake form itself (v1 charter)

- Template `intake` (form_key), ported from Jotform 231710991971158 (pull the
  field list via the Jotform MCP connection at prompt-writing time). ~7
  awareness-oriented questions. Plain template: no code/css/hooks/embed (the
  refusal gate makes this mandatory, not stylistic). badLink=degrade.
  visibility='public'.
- Prefill: name/phone/email via §5.2. PII leaves the URL entirely vs. the
  Jotform chain.
- Per-type variants later via distinct form_keys (intake_bk etc.) with distinct
  links in the sequence templates; no server-side type dispatch in v1.
- Cutover = editing the intake SMS sequence template link to
  `app.4lsg.com/f/intake?case_id={{case_id}}` + retiring the go.4lsg.com Pabbly
  redirect + prefill-pull flows (two more Pabbly retirement wins; the booking
  case_source repoint remains queued separately).
- onSubmit.workflow: RG alert wiring for the anonymous branch; optional log
  entry on the linked branch.

## 8. Slice X4 — Form Inbox

Authed staff page (index.html more-panel pattern): lists unlinked submissions
(`link_type=''`), read-only rendered view (render.html's existing readonly
mode — one renderer, always), and an adopt/link-to-case action
(OrphanAdoptDialog precedent) that sets link_type/link_id and stamps who linked
it. RG alert on arrival is the notification; the Inbox is the workspace. PDF
export deliberately deferred — structured data beats artifacts.

## 9. Security review checklist (portal manager co-review, gates X2 ship)

1. Refusal scan correctness: every refused key, checked per-request, generic
   response. 2. Prefill projection: exactly three fields, Primary only, no wider
   SELECT anywhere in the path. 3. Inversion holds: grep for any client-supplied
   link/URL/id reaching a query outside the case_id resolution. 4. No-oracle
   audit across all refusal branches. 5. Rate-limit keying via getClientIp;
   per-case cap present. 6. apiColumn dead externally (test-locked). 7. Server
   re-validation can't be bypassed by shape tricks (arrays where strings
   expected, prototype keys). 8. render.html external error states leak nothing.
9. visibility flip refusal (server-side) test-locked.

## 10. Slicing and ownership

| Slice | Content | Notes |
|---|---|---|
| X1 | visibility column (migration, ref/-dated, idempotent) + validateDefinition external.badLink key + flip refusal + builder visibility control | additive; nothing external serves yet |
| X2 | routes/f.js + /api/ext/forms GET+submit + yc-forms external-mode completion ($load feed, error states) + rate limits | gated by §9 review; ships dark (no public template exists until X3) |
| X3 | intake template port + SMS template cutover + Pabbly redirect retirement | the business deliverable |
| X4 | Form Inbox | can trail X3 by days; RG alert covers the gap |

Forms manager executes (arc currently paused — this doc is the contract waiting
for resume); portal manager co-reviews §9; supermanager arbitrates disputes.
Test-lock culture applies: every §9 item that can be a jest assertion becomes one.

## 11. Explicitly out of scope

form_tokens (reserved), external code/css/hooks/embed (refused pending on-demand
review), server-side external drafts, per-type intake dispatch, PDF export of
submissions, any change to internal-tier behavior, contact_info template port
(separate forms-arc decision), payment anything.