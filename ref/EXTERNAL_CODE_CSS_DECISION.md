# External `code`/`css`/`hooks`/`embed` policy + form-dev gate — decision record

**Dates:** 2026-08-16 (two rounds, same day). **Decided by:** delegated Claude
session + Fred, who reversed the first round's external ban after two
arguments (below). **Ships with:** `ref/2026-08-16_form_dev_role.sql`,
`lib/auth.formDev.js`, service/route gates, builder warnings,
`external.appearance`. **Chartered next:** origin separation + SU step-up
(see the worker prompt Fred holds).

## Two wrong arguments, kept as markers

1. *"External `code` must stay refused because template JS could read the
   staff JWT from localStorage on app.4lsg.com."* Every fact true, conclusion
   invalid — internal forms already executed authored JS with no authoring
   gate, so the capability existed regardless of the external refusal. The
   JWT risk is an AUTHORING problem, identical on both surfaces.
2. *"/p pages are safe because they're repo code behind the deploy
   pipeline."* Flat wrong — `routes/api.pages.js` is plain jwtOrApiKey CRUD
   over raw HTML served verbatim by `routes/pageLanding.js`. Any staff JWT
   can put arbitrary JS on the app origin, publicly served, at runtime. The
   session that made argument (1)'s correction made this one.

Lesson, twice: re-derive threat models from the repo, not from prose —
including your own previous prose.

## The final model (Fred-ratified)

**Gate authorship, warn at exposure, ban nothing content-wise.**

- **form_dev gate** (`lib/auth.formDev.js`: SU `user_auth`, roles
  `it`/`form_dev`, or any api_key) on the acts that put executable content
  into TEMPLATES: introducing/changing/removing top-level `code`/`hooks`/
  `css` in create/update/restore (a DIFF gate — byte-identical round-trips
  pass, so plain staff still field-edit code-carrying templates), and
  flipping visibility off-internal. Enforced in the service, fail-closed
  authz param, legible 403s naming the keys and the role, audited
  (`admin_audit_log` tool `form_templates`). Granted to user 6 (IT) only.
  Justification: internal form code executes in staff browsers ON THE APP
  ORIGIN by design — origin separation never fixes that — so authoring it is
  gated against the phished-staff-account scenario. (Fred's stated position:
  authorized staff going rogue is not the threat being defended against.)
- **`/api/pages` is NOT gated** (Fred's call): staff may author landing
  pages freely. The pageManager editor carries a persistent no-third-party
  warning banner. The JWT-snatch exposure this leaves on the app origin is
  accepted PENDING the chartered origin-separation slice, which removes it
  structurally (landing origin has no staff JWT to steal).
- **The §4 external refusal invariant is RETIRED.** Templates carrying
  `code`/`css`/`hooks`/embed fields SERVE and EXECUTE externally:
  `scanExternalRefusals` no longer refuses anywhere (kept as the advisory
  scanner behind the builder's standing badge and the publish notice,
  `external_executes`); `projectDefinition` admits `code`/`css`/`hooks` and
  embed `height` onto the ext wire; the renderer executes them in ext boots
  (it always could — projection was the last gate). Embed's https-only src
  re-check stands. Concrete driver for embed: the Ash auto-scheduler iframe
  on the initial-strategy-session form.
- **Warnings at the exposure moments** (the mechanism that converts
  unwitting to witting): the visibility expose-confirm and the publish
  confirm (when externally visible + executing keys present) both carry:
  *no third-party scripts, fonts, pixels, or tracker iframes — any external
  resource discloses that the visitor is consulting a bankruptcy firm; the
  standing topbar badge* ("⚠ runs in clients' browsers") *persists after.*
  Same banner in pageManager.
- **`external.appearance`** (`bgFrom`/`bgTo`, strict hex) stays as the
  zero-privilege styling channel — no form_dev needed, inert by grammar.

## The privacy risk, stated once, honestly

Third-party resources on public intake/landing surfaces disclose
prospective-client status (visitor IP + fingerprint + "on a bankruptcy
intake page now") to the resource's host. That is a genuine gray zone —
Model Rule 1.18/1.6 prospective-client confidentiality, and FTC pixel
enforcement (BetterHelp, GoodRx, tax-prep cases) are live analogies — but
it is not a clean "illegal," and Fred, as owner, accepts it wittingly with
the warnings in place. This paragraph exists so nobody later mistakes the
reversal for the risk having been analyzed away. The warnings are the
control; the CSP on the future landing origin can harden them into
browser-enforced policy if ever wanted.

## Residual exposures accepted / deferred

1. **Staff-initiated JWT snatch via /p pages or external form code** on
   app.4lsg.com: accepted pending ORIGIN SEPARATION (chartered) — serve
   /p, /f, ext render, /api/ext from a separate origin; localStorage is
   origin-scoped, so the staff JWT becomes unreachable from anything
   staff-authorable-and-public. SU STEP-UP (password re-prompt on SU
   tools) chartered alongside as the cheap independent win.
2. **`content.src` pixel-lite** (any https image on a public form leaks
   visitor IP/timing to the image host) — now strictly dominated by the
   reversal (code is allowed anyway); moot as a separate control.
3. **Credentialed URLs in tracked wrappers**: a form URL carrying case_id
   must never be embedded in a page with third-party scripts — the outer
   page reads location.href AND the iframe src attribute. Marketing-site
   embeds: anonymous mode only. Landing pages on the future separate
   origin inherit the same rule via their warning banner.

## Rollout / revert

- Deploy order: `ref/2026-08-16_form_dev_role.sql` → backend → frontend.
- Non-IT staff lose: editing code/hooks/css VALUES on templates, and
  exposing templates externally. Everything else — including landing-page
  authoring and appearance styling — unchanged or newly opened.
- Revert the form_dev gate without a deploy: grant `form_dev` broadly (one
  UPDATE, recipe in the migration); effective at next login (24h JWT).
- Revert the reversal (re-ban external code/css): restore the three
  scanExternalRefusals consumers and drop code/css/hooks/height from the
  projection allowlists — the scanner itself never left.
