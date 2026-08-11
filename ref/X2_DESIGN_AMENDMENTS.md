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
