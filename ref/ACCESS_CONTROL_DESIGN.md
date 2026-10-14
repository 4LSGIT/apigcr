# Access Control — Design (ratified 2026-10-14; living doc)

Status: **RATIFIED 2026-10-14** (Q1–Q4 ruled; Fred's go in session).
Canonical home: this file. The pre-ratification draft lived in local/
(gitignored).
Manager state: scratch `fred/access_control_state`. Coordination:
`fred/admin_surface_coord`.

Every claim below verified 2026-10-14 against the live DB (RO key) and
actual source — including where it contradicts the arc's boot prompt.

---

## 1. Current reality (verified 2026-10-14)

The boot prompt's "no role tier exists" is stale. **A role system already
half-exists.** There are FOUR coexisting authorization mechanisms:

### 1a. `users.user_auth` (varchar, string-matched)
Live values: `'authorized'` ×8, `'authorized - SU'` ×1 (user 6, IT).
Semantics today: **authn status + SU flag fused into one string.**
- `startsWith('authorized')` = may hold a session (jwtOrApiKey:170,
  requireAuth:410, auth.login:56, plus the legacy plaintext routes).
- `=== 'authorized - SU'` = superuser (`lib/auth.superuser.isSuperuser` —
  the declared single source of truth; its own comment says "when a proper
  role column is introduced, update isSuperuser()").
- `'authorized - admin'` is a **phantom tier**: checked in exactly two
  files (`api.issueReports.js:46`, `api.featureRequests.js:23`
  `ADMIN_AUTH`), zero holders, and **cannot be assigned** —
  `admin.users.js:54 ALLOWED_AUTH = ['authorized','authorized - SU','disabled']`.
- `'disabled'` = the off switch (admin.users disable/enable).

### 1b. `users.roles` — SET('it','admin','staff','attorney','automation','form_dev')
Exists since 2026-08-16 (`ref/migrations/2026-08-16_form_dev_role.sql`).
Live holders: user 6 = `it,admin,form_dev`; user 1 (SS) = `staff,attorney`;
users 2,3,4,5,22,23 = `staff`; user 0 (automations pseudo-user) = `automation`.
- Minted into the 24h staff JWT at login (`auth.login.js:66` — grant/revoke
  takes effect at next login).
- `requireAuth({audience:'staff', roles})` (lib/auth.requireAuth.js) — the
  designed enforcement seam. **Complete, tested, mounted on ZERO staff
  routes** ("phased coexistence; later M-slices migrate route-by-route").
  Legacy tokens without a roles claim fail closed; `'it'` bypasses the role
  check (only the role check); authz failure = 403 vs authn 401.
- Real consumers today: `form_dev`/`it` (lib/auth.formDev.js predicate,
  template code authoring); `attorney` (mailboxService READ_BYPASS_ROLES —
  read every mailbox + phone line without a grant row); `automation`/role
  filters (lib/internal_functions/users.js).
- **No roles UI** — admin.users PATCH whitelist omits `roles`; DB console only.

### 1c. `channel_grants` — object-scoped ACL (the precedent)
`(user, channel_type, channel_id, can_read, can_send, can_manage,
granted_by)` over mailboxes + phone lines; 10 live rows; grant APIs are
SU-or-can_manage; `attorney` role = documented read-only bypass. This is a
**per-resource rights** axis, orthogonal to roles.

### 1d. Keys (Phase B subject matter, inventoried for completeness)
Three prefixes exist (AUDIT_TENANCY §: `ycp_` does NOT exist; portal tokens
are unprefixed JWTs, aud `contact`):
- `yci_` internal self-credential (firmConfig dual-slot, rotation-safe).
- `yck_` external write keys (`api_keys`: hash, label, revocable, **no
  scope column** — full jwtOrApiKey surface; requireAuth's allowApiKey
  path skips role checks entirely: "machine trust").
- `ycro_` readonly session keys (`readonly_api_keys`: hash, expiry,
  ip_allowlist; suffix after 2nd `_` is advisory). Misnomer: authorizes
  readonly SQL + scratch writes + IT alerts.

### 1e. SU hardening already in place (keep)
`superuserOnlyFor(tool)` = jwtOrApiKey → SU check → **elevation step-up**
(15m `su-elev` JWT vs own password, X-SU-Elevation, kill switch
SU_STEPUP=0) → per-tool rate limit → `admin_audit_log` on every rejection.

### 1f. The sprawl (the migration's real work)
~81 `user_auth` grep hits, but the enforcement chokepoints reduce to:
| Site | Check | Phase A disposition |
|---|---|---|
| jwtOrApiKey:170, requireAuth:410, auth.login:56 | startsWith('authorized') | stays — authn status check |
| lib/auth.superuser.isSuperuser | === SU string | **the** chokepoint: reroute to capability |
| consumers of isSuperuser (dbConsole, checklists, api.mailboxes, alerting, ctaService, admin.* via superuserOnlyFor) | delegated | free once isSuperuser moves |
| api.reports.js:90, auth.customTab.js:73 | direct SU string | point at isSuperuser/can() |
| mailboxService.isSuperuserDb (DB read, not JWT) | === SU string | capability read from DB (pattern stays) |
| ADMIN_AUTH ×2 (issueReports, featureRequests) | phantom admin | replace with `can('firm.settings')` or kin |
| admin.users.js | writes user_auth | gains roles write + new enum |
| dbQuery / db64 / dropbox / unplacehold / temp_auth_validate | plaintext `users.password` + startsWith | legacy; never gain role semantics; retirement tracked in plans.md (blocked on Phase 6) |
| internal_functions/users.js, reportSchema/manifest | expose/describe values | follow-on rename only |

### 1g. Gates currently missing (the demand side)
- `PUT/POST /api/app-settings*` — gated behind `firm.settings` since A4
  (requireAuth({can}), the first staff-route mount; GET and per-row
  `is_editable`/`is_secret` unchanged). yck_ keys still pass per Q3 until
  Phase B. Before A4 this was plain jwtOrApiKey — CFG-3's founding finding.
- ui-custom S3 firm-layer writes will need the same tier (ONE surface
  ruling).
- comms-archive R9 (Restrict/Purge/comms_no_transcribe = SU+SS): wanted a
  role, **parked as an app_settings user-list** until this arc lands —
  registered here as capability debt (§6).
- Tool authoring: SU today, ruled "top capability" (plans.md 2026-10-05).

---

## 2. Phase A design

### 2.1 Principles
1. **Finish the built seam, don't invent a second one.** `requireAuth` +
   `users.roles` + the JWT roles claim are the design; Phase A completes
   and ratifies it rather than replacing it.
2. **Capabilities are the stable vocabulary; roles are grantable bundles.**
   Routes and services cite capabilities. Role→capability mapping is a
   code-defined registry (config-as-data deferred: inner-platform guard —
   no second tenant demonstrably needs custom roles; DB-per-tenant makes
   per-tenant role *assignment* free anyway, the *taxonomy* stays code).
3. **Deny-by-string dies.** `user_auth` collapses to authn status;
   authorization moves wholly to roles/capabilities.
4. **Object-scoped grants stay fenced** (§2.7).
5. Clients (portal, aud `contact`) are a separate population — untouched.

### 2.2 Role taxonomy (v2, fixed) — Q1/Q2 RULED 2026-10-14
Keep the SET column, add one member: **`su`**. Fred's framing: SU is a YC
(platform) role — nothing blocks it ever; IT is a firm role with technical
access to everything the firm has. Encoded as **root-grade vs firm-grade
capabilities**:

- **Root-grade** = surfaces that are effectively arbitrary code/SQL within
  the tenant: the SU admin tools (DB console, API tester, elevation-gated
  chain), `tools.author` (plans.md ruling: "tool authoring = root within
  the tenant"), and granting `su` itself.
- Everything else is **firm-grade**.

| Role | Meaning | Capabilities |
|---|---|---|
| `su` | root within the tenant (the YC role) | everything — nothing blocks it ever |
| `it` | firm technical operator | **all firm-grade capabilities** (incl. `firm.settings` — Q2 yes), never root-grade |
| `admin` | firm administrator | `firm.settings`, `users.manage`*, `automations.manage`, `archives.purge`† |
| `staff` | baseline employee | the implicit everything-not-gated surface (no registry entry needed in v2) |
| `attorney` | legal read scope | `comms.read_all` (the existing mailbox/phone read bypass) |
| `form_dev` | template code author | `templates.code` |
| `automation` | machine pseudo-user | none (exists for attribution/filtering, not grants) |

Tenancy note: when DB-per-tenant lands, platform-operator access becomes
the identity ruling's separate audited explicit-elevation workflow; `su`
is the single-tenant stand-in for it today. Whether a tenant keeps a
resident `su` holder (vs `it` as the tenant ceiling) is decided then —
nothing in this design forecloses either.

**Adding a role stays cheap by construction** (Fred's constraint): one
`ALTER TABLE ... MODIFY roles SET(...)` appending the member (append-only —
never reorder/remove SET members), one `ROLE_CAPS` registry line, snapshot
test updates. No route changes.

\* `users.manage` stays SU-only in v2 (admin.users keeps
`superuserOnlyFor('users')`); listed to show where it lands if delegated.
Granting `su` is root-grade regardless.
† when comms-archive migrates off its app_settings interim (§6).

`user_auth` becomes a status enum in behavior (values `'authorized'` /
`'disabled'`; column/physical type untouched in v2 — rename/retype is
gratuitous churn). `'authorized - SU'` and the phantom
`'authorized - admin'` are eliminated.

### 2.3 Capability model & registry
`lib/capabilities.js` (new, small):
- `CAPABILITIES` — the closed list of capability names, each with a one-line
  meaning and a `root: true|false` flag (§2.2). Seeded ONLY with proven
  demand: `firm.settings`, `tools.author` (root), `users.manage` (root in
  v2 — delegation later is a registry flip), `templates.code`,
  `comms.read_all`, `archives.purge`, `automations.manage`. Growing it = a
  code change + test snapshot (same deliberate-choice pattern as
  CTA_FN_DENYLIST). Shipped in A1 as `lib/capabilities.js`.
- `ROLE_CAPS` — role → capability-set map (table above). `su` and `it` are
  not enumerated: `su` passes everything; `it` passes every non-root
  capability — so a new capability is `it`-reachable by default unless
  flagged root, and a new role is one map line.
- `can(auth, cap)` — predicate: `su` → true; `it` → true unless
  `CAPABILITIES[cap].root`; else union of the holder's roles' capability
  sets. Works on `req.auth` (JWT roles claim) — this is the existing
  requireAuth `it`-bypass rule, generalized and made precise (today `it`
  passes ANY role gate; under can() it passes any non-root capability).
- `requireAuth` gains `can: 'capability'` beside `roles:` (mutually
  exclusive — passing both throws at mount; `roles:` stays for
  literal-role gates). Known pre-existing quirk, out of A1's scope: in the
  allowApiKey JWT-fallthrough, a 403 leaves jwtOrApiKey's earlier
  'authorized' audit row as the only record (flagged A1 J5; fix rides any
  later audit slice).
- **Freshness rule (carried from mailboxService):** destructive or
  security-sensitive checks (purge, grants admin, SU tools) read
  roles from the DB at decision time, not from the 24h JWT claim.
  Convenience/visibility checks may trust the claim.

### 2.4 SU migration — split A2 / A2b (structural ruling, 2026-10-14)

Executed as TWO slices, because 11 `public/` files gate SU UI on the
literal `user_auth` string (via `firmData.currentUser`) — collapsing the
string before they migrate would hide SU tools from its holder. And with
dual-accept live, **no `JWT_VERSION` bump / forced logout is needed**:
A2b trailing ≥24h lets every pre-A2 token expire naturally.

- **A2 (backend, zero behavior change):** stage-1 migration (SET += `su`,
  grant to the legacy holder), `isSuperuser` → su-role with the legacy
  string dual-accepted, `rowIsSuperuser` for the DB-row sites (disabled
  users are never SU — the off switch is explicit now that SU survives in
  `roles`), straggler reroutes (incl. `lib/auth.formDev.js`), phantom
  admin tier removal.
- **A2b (SHIPPED 2026-10-14, merged with A3):** the 11 frontend files → roles-based (overlaps A3's
  users.html work), stage-3 `user_auth` collapse, legacy-string branch
  removal (`auth.superuser` ×2, `capabilities.js`, mailboxService
  `SU_AUTH`), `ALLOWED_AUTH` shrink, `services/commsArchiveAdmin.js`
  follow-up, stale SU-string prose (mailboxService header,
  api.mailboxes audit reason, admin.users/admin.dbConsole/api.checklists
  comments), `internal_functions/users.js` + reportSchema manifest notes.
Mechanics (A2 ships 1–3; A2b ships 4–5; the roles-UI half of 5 is A3):
1. Stage-1 migration: `ALTER` the SET to add `su` (append-only, INPLACE);
   `UPDATE users SET roles = CONCAT_WS(',', NULLIF(roles,''), 'su')
   WHERE user_auth='authorized - SU'` — `scripts/accessA2SuRole.js`.
2. `isSuperuser(auth)` — the declared chokepoint — becomes a roles check
   (`roles.includes('su')`), accepting the legacy string until A2b deletes
   the branch. `rowIsSuperuser(row)` serves the DB-row sites and requires
   `user_auth` to start with 'authorized' — disabling a user strips SU
   effect immediately, as the string regime did implicitly.
3. Point the stragglers (§1f rows 4–6, plus `lib/auth.formDev.js`) at
   `isSuperuser`/`can()`.
4. Stage-3 collapse (`'authorized - SU'` → `'authorized'`) + string-branch
   deletion, in A2b. No `JWT_VERSION` bump: pre-A2 tokens expire naturally
   within 24h, so A2b trailing ≥24h never mixes semantics.
5. admin.users: `ALLOWED_AUTH` shrinks to `['authorized','disabled']` (A2b);
   PATCH whitelist gains `roles` (A3; validated against the SET members,
   `su` assignable only by an SU caller — no self-service root).

### 2.5 Membership management
Roles UI lives in the existing admin users pane (SU-gated,
`superuserOnlyFor('users')`, audit rows already flow). Grant/revoke
effective at next login (24h ceiling) EXCEPT capabilities that read the DB
(§2.3 freshness rule) — effective immediately. This matches today's
behavior for form_dev/attorney and is acceptable at this user count.

### 2.6 Entitlements (S3b — owned here, as transferred)
Ratified constraints honored: firm/role/user levels; **deny wins**; server
resolves a denied set; **visibility-only in v2** with a route-enforcement
seam for later; `moreSettings` and `helpSupport` never deniable
(registry keys per public/js/featureRegistry.js — ui-custom S1 prefixes
grid items more*/admin*; Settings moved into the More grid 2026-10-11).

- Storage: table `entitlement_denies (id, scope ENUM('firm','role','user'),
  scope_ref varchar NOT NULL — '' for firm / role name / users.user as
  digits, item_key varchar, created_by, created_at)`, UNIQUE (scope,
  scope_ref, item_key). Firm is the `''` sentinel, not NULL: a UNIQUE index
  treats NULLs as distinct, so a nullable firm scope would store one firm
  deny twice — and ui_config spells "unscoped" the same way (its role column
  sentinel `''`, §6). **Deny-only rows** — "deny wins" and "default allow"
  fall out of the storage shape; no allow/deny precedence logic to get
  wrong. Built in A5: `scripts/accessA5Entitlements.js`,
  `services/entitlementService.js`, `routes/api.entitlements.js`.
- Resolution (server): denied(user) = denies(firm) ∪ denies(user's roles)
  ∪ denies(user), minus the undeniable set (`moreSettings`, `helpSupport` —
  enforced at write AND at resolve, belt-and-braces). Delivered to the
  shell as `denied: [item_key...]` in the firmData/ui-config payload the
  launcher already fetches.
- `item_key` vocabulary = the launcher registry keys that ui-custom S1
  extracts; this arc owns the table + resolver, ui-custom consumes the
  denied set when it builds the launcher. Cosmetic firm/user hide stays in
  ui-custom (its ruling stands: hiding secures nothing).
- Enforcement seam (later, designed now): each registry item MAY carry a
  route-family prefix list; a v3 middleware maps denied item → 403 on its
  route family. v2 ships the column-less version (visibility only); no
  route behavior changes.
- Registry-external chrome: the shell header greeting (index.html, .hdr-greeting) opens tabSettings directly — not a registry item, so a tile deny would not hide it. Irrelevant while Settings is undeniable; the resolver slice records it as the one launcher route outside the registry.
- Admin surface: entitlement editing = `firm.settings` capability, inside
  the ONE firm-config surface (§3).

### 2.7 channel_grants ruling: FENCE, don't unify
Keep `channel_grants` (and future object-scoped tables, e.g. per-case
restrictions) as a **separate axis**: per-resource rights, granted per
user, administered by SU-or-can_manage. Roles interact with object scopes
only via **named, documented bypass capabilities** (`comms.read_all` ≡
today's attorney READ bypass — read-only, never manage).

Why not unify into a generic grants table: 9 users, two channel types, one
proven bypass — a generic `(principal, object_type, object_id, verb)`
engine is the inner-platform trap, and it would reopen ratified mailbox-arc
semantics (staffSendGate, listReadable) for zero current demand. The fence
is a rule, not just a default: **a new object-scoped need copies the
channel_grants pattern (own table, own verbs, SU-or-manager grant APIs)
and registers any role bypass as a capability in the §2.3 registry.**
The settings-arc "My access / Manage access" rider stays UI-exposure-only
(listReadable already returns exactly it; role-bypass rows display "via
role") — this model keeps that true.

### 2.8 Target state for legacy authn
Design states the target (retirement itself tracked in plans.md, blocked
on Phase 6): dbQuery/db64/dropbox-legacy/unplacehold/temp_auth_validate
retire → `users.password` (9 plaintext) and `tempusers` (2 plaintext) are
DROPPED. Until then those routes stay frozen: never gain role semantics,
never accept the new enum beyond `startsWith('authorized')`.

---

## 3. The role-model contract (citeable — for CFG-3 and ui-custom S3)

1. **Taxonomy:** `users.roles` SET = `su | it | admin | staff | attorney |
   form_dev | automation`. Fixed in v2; custom roles are not a thing.
2. **The admin capability is `firm.settings`.** Held by roles `admin`,
   `it` and `su` (ruled 2026-10-14). Gate expression:
   `requireAuth({ audience:'staff', can:'firm.settings' })` once A1 lands;
   until then `roles:['admin']` (su/it pass via bypass rules).
3. **CFG-3 and the role-gated firm-settings editor are ONE surface**, gated
   by `firm.settings`. `PUT/POST /api/app-settings*` gains that gate in
   slice A4; per-row `is_editable`/`is_secret` semantics unchanged.
4. **Launcher resolution order: registry → firm → role → user.** The role
   step is additive later (ui-custom S3 ships firm+user with the role
   column sentinel-reserved); entitlement denies overlay the result and
   deny wins; `moreSettings`/`helpSupport` undeniable.
5. Entitlement storage/resolve is owned by THIS arc (§2.6); ui-custom
   consumes `denied[]`; settings arc consumes the gate (§3.2–3).
6. Machine callers (x-api-key) bypass role gates in v2 (status quo,
   explicit); Phase B gives keys their own capability scopes.

---

## 4. Security-debt triage (from `fred/security-debt`)

**Immediate hygiene — no design dependency, Fred can run now:**
- H1 `DROP TABLE email_credentials_backup_20260513` (unreferenced; 7 SMTP
  passwords). One migration.
- H2 Revoke RO key 45 'gpt' (live to 2028) unless actively used.
- H3 Referer-password cleanup: write-time redaction already landed
  (SEC-1, jwtOrApiKey 2026-10-12). Remaining: rotate the Ssandweiss app
  password if current; SU-console scrub the ~21 rows + audit the 344
  `LIKE '%pass%'` rows. "Find the page" is answered: stale auto-login
  bookmarks (`/?user=&pass=`) — rotation kills the exposure.
- H4 `tempusers` (2 plaintext rows): drop or fold into the legacy-route
  freeze (§2.8) — needs a 2-minute usage check first.

**Phase A deliverables:** phantom admin tier removal (§2.4.5); plaintext
`users.password` target state (§2.8).

**Phase B deliverables:** `hooks.auth_config` + `credentials.config`
RO-readable plaintext (column-level redaction in sqlGuard, or encrypt at
rest — SECRET_TABLES is table-granular and sessions legitimately query
both tables, so this needs design, not a one-liner); SU-console
secret-write pattern (admin_audit_log.details.query_text) + the undecided
pre-commit secret scan; key-format shortening; RO-key scope honesty.

---

## 5. Phase B — scoped keys (RATIFIED 2026-10-14)

Supersedes the pre-Phase-A outline. Grounded live 2026-10-14 (RO queries +
source). Ratified same day; slices B1-B4 may dispatch.

### 5.1 Verified key reality

- Three prefixes exist; `ycp_` does not (portal = unprefixed JWT, aud
  `contact`). `yci_` = the app's own self-credential (firmConfig dual-slot,
  rotation-safe). `yck_` = `api_keys` (7 rows live 2026-10-14: Pabbly, the
  two Cloud Scheduler keys, fil2-session, an idle `temp` — and 2 revoked);
  a yck_ key has the FULL jwtOrApiKey surface and bypasses role/capability
  gates (Q3). `ycro_` = `readonly_api_keys`; identity = sha256 of the first
  two `_`-segments, suffix advisory (expiry stamp).
- **The "readonly" key's real surface** (routes mounting
  `lib/auth.readonly`): readonly SQL, scratch WRITES, IT alerts, **and the
  four `api.temp.*` provider proxies (clio / dropbox / ringcentral /
  zohosign) — credentialed calls to external providers.** Wider than the
  documented trio; the misnomer is worse than Phase A's framing knew. The
  temp routes are individually slated for deletion at their arcs' closes
  (comms F7 covers ringcentral), but the CLASS must be scope-gated: any
  future temp route must not ride in silently.
- Live long-expiry session keys: id 45 `gpt` (idle since 2026-06, revoke —
  hygiene H2, STILL OPEN), id 69 `long`, id 75 `claude long key` (both to
  2028, active).

### 5.2 One scopes vocabulary (the design)

Both key tables gain a nullable `scopes` column (JSON array of strings).
**NULL = legacy full surface** — rollout is per-key, no flag day; the
admin/mint UIs set scopes on new keys and can retrofit old ones.

Scope grammar, one flat namespace, three families:

- **Surface scopes** (session keys): `sql.ro`, `scratch`, `alert`,
  `temp.clio`, `temp.dropbox`, `temp.ringcentral`, `temp.zohosign`. Each
  auth.readonly-mounted route declares its surface; `keyAllows(auth,
  scope)` enforces. New session-key mints default to
  `["sql.ro","scratch","alert"]` — the documented trio; `temp.*` becomes
  an explicit grant.
- **Route scopes** (machine keys): `route:/process-jobs`,
  `route:/mailbox-ingest` — path-prefix match applied in jwtOrApiKey when
  the key row carries scopes. The two Cloud Scheduler keys get exactly
  their one route each.
- **Capability scopes** (machine keys): the §2.3 registry names. A scoped
  yck_ key no longer blanket-passes `can()` / requireAuth's allowApiKey
  path — it passes only the capabilities it carries. **This is how the Q3
  machine-trust bypass retires**: per key, as each key gets scoped, with
  NULL keys keeping today's behavior until touched.
- Session-key "upgrades" (e.g. let a Claude session create one task) =
  capability-style named allowances in the same column, validated against
  a closed list exactly like `item_key` (unknown scope at mint = fail
  loud, not fail open).

Enforcement seam: `lib/apiKeys.lookup` / auth.readonly attach the key's
scopes to `req.auth`; one shared `keyAllows()` beside `can()` in
lib/capabilities.js. Snapshot-test the scope vocabulary (the
deliberate-choice pattern).

### 5.3 Naming + format

- `ycro_` is renamed CONCEPTUALLY to **session key** (docs, CLAUDE.md, UI
  copy at ship time). The prefix string stays — hashes and muscle memory
  are stable; the prefix was never the semantics.
- New mints (both families): body → **22-char base62** (~131 bits); stored
  hash unchanged in shape; old keys keep working (hash of whatever was
  minted). The advisory-suffix mechanics survive as-is.

### 5.4 Tenancy (plans.md open decision 6 — decided here)

- Per-tenant genuinely-read-only MySQL users for `/api/readonly/sql`
  remain a **prerequisite for the first paying tenant** (tenancy invariant
  9); single-tenant ships nothing.
- Session/machine keys live in the tenant DB, so they are tenant-bound by
  construction once resolution is per-host; the known cross-tenant
  acceptance holes are the `yci_` firmConfig check and the process-global
  key cache, both already owned by tenancy P0-4f/P0-5 (AUDIT_TENANCY),
  not by this arc.

### 5.5 Secrets (the Phase B half of §4)

- **Secret VALUES encrypted at rest** (B4), not tables hidden: only the
  named JSON fields are ENCv1 (lib/credentialCrypto); every other key
  stays queryable. `lib/secretAtRest.js` names the fields:
  - `hooks.auth_config` (8 hooks: 6 api_key `$.key`, 2 Calendly hmac
    `$.secret`). Decrypted only in hookService.authenticateRequest (the
    inbound verify) and the two editor display routes. SECRET_TABLES +=
    hooks was the earlier plan; readonly_query_log falsified its premise
    on 2026-10-14 — 294 session queries read hook metadata (52 in the
    prior 30 days), only 20 even named auth_config.
  - `credentials.config` (3 static api_keys live 2026-10-14 — Quo,
    Claude, Assembly AI — not 2; plus bearer `$.token` / basic
    `$.password` when they exist; oauth2 `$.client_secret` already was).
    Decrypted only in credentialInjection.buildAuthHeaders and the SU
    `/api/credentials/:id/reveal`.
  - Dual-read (an ENCv1 value decrypts, plaintext passes) so the code
    deploys FIRST and `scripts/accessB4SecretsAtRest.js` migrates the
    rows after. Writes encrypt idempotently (credentials POST/PUT,
    hookService create/update; duplicateHook copies ciphertext).
  - The management API still returns decrypted hook secrets to any staff
    JWT (ruling H1: display parity); gating `/api/hooks` behind
    `automations.manage` is follow-up B5.
- SU-console secret writes landing in RO-readable
  `admin_audit_log.details.query_text`: the **pre-commit secret scan**
  (`.githooks/pre-commit` → `scripts/secret-scan.js`) refuses staged
  lines adding a yci_/ycro_/yck_ key in its real minted shape or a
  common provider secret; documenting the in-SQL-generation path for
  setting secrets is still open; audit-row redaction stays the reactive
  backstop.
- Hygiene outcomes (ruled 2026-10-14): H1 DONE (table dropped by Fred).
  H2 RULED KEEP — the gpt RO key is intentional, not an error; struck
  from the debt list. H4: `tempusers` is dead (zero code references;
  junk rows) — recommended `DROP TABLE tempusers`, awaiting the drop.
  H3 (Ssandweiss referer rotation/scrub) status unknown to this arc —
  confirm or strike at close.

### 5.6 Slice plan — Phase B (post-ratification)

- **B1** `scopes` column (both tables, one migration) + `keyAllows()` +
  surface enforcement on every auth.readonly route; new-mint defaults.
  NULL=legacy throughout. Unblocks everything else.
- **B2** Machine-key scoping: route scopes on the two scheduler keys
  (mint fresh scoped keys, swap in the job configs, revoke old — the
  INFRA_GCP §10 runbook pattern); capability scopes in the api-keys admin
  UI; retire Q3 per scoped key.
- **B3** base62 mint format + UI copy ("session key" rename lands here).
- **B4** Secrets: hooks.auth_config + credentials.config secret values
  encrypted at rest (code first, then the data script — §5.5);
  pre-commit secret scan. (Hygiene sitting rides whenever Fred has 10
  minutes.)
- **B5** `/api/hooks` management routes behind
  `requireAuth({ can: 'automations.manage', allowApiKey: true })`
  (the receiver `/hooks/:slug` untouched). Needs an admin_surface_coord
  entry and Fred's go.

---

## 6. Interim-gate ledger (migrate when A lands)

| Interim | Where | Target |
|---|---|---|
| comms-archive R9 Restrict/Purge/no_transcribe allow-list | app_settings (their S1 decides the key) | `archives.purge` capability (role `admin`/`su`, DB-read freshness) |
| ADMIN_AUTH phantom checks | issueReports/featureRequests | A2 chose a third option: SU-only via `isSuperuser` (strictly behavior-preserving; today equal to `can('firm.settings')` since the only `it`/`admin` holder is the SU). **Ratified 2026-10-14** — flip to `can('firm.settings')` later if admin-tier demand appears |
| ui-custom per-role firm defaults | DDL sentinel `role=''`, writes rejected | role step in resolution order (contract §3.4) |

---

## 7. Slice plan — Phase A (post-ratification; each independently deployable)

- **A1** `lib/capabilities.js` registry + `can()` + `requireAuth({can})` +
  snapshot tests (eligible-set pattern). No route behavior change.
- **A2** SU migration, backend half: SET member `su`, stage-1 data
  migration, isSuperuser → roles (dual-accept), rowIsSuperuser, straggler
  sites, phantom-tier removal. Zero behavior change, no logout.
- **A2b** (shipped 2026-10-14, merged with A3; the 24h wait was replaced by the SU holder re-logging-in) SU migration, cutover half: the 11
  frontend string-gates → roles, stage-3 user_auth collapse, legacy-string
  branch deletion, ALLOWED_AUTH shrink, commsArchiveAdmin follow-up, stale
  prose sweep. May merge with A3 (users.html overlap). §2.4 has the split
  rationale.
- **A3** (shipped 2026-10-14, inside A2b) Roles UI in admin users pane
  (PATCH whitelist + validation + su-only-grants-su + no-self-su-removal)
  — real membership management is live.
- **A4** `firm.settings` gate on app-settings writes (**coordinate:
  settings arc owns the surface — entry in `admin_surface_coord` before
  any worker prompt**). Unblocks CFG-3.
- **A5** `entitlement_denies` table + resolver + `denied[]` in the shell
  payload + undeniable-set tests. Unblocks ui-custom launcher consumption.
- **A6** Interim-gate migrations (§6) as their owners come ready.

A1→A2→A3 ordered; A4/A5 parallel after A1; A2 is the only slice needing a
logout window. Hygiene H1–H4 ride whenever — they don't wait for
ratification.

---

## 8. Open questions

**RULED 2026-10-14 (Fred):**
- **Q1 — `it` vs `su`: two tiers, root-grade vs firm-grade.** SU is the
  YC role, nothing blocks it ever; IT is a firm role with technical access
  to everything the firm has. Encoded in §2.2/§2.3. Taxonomy must stay
  cheap to extend (the add-a-role recipe in §2.2 is the contract for that).
- **Q2 — yes:** `it` holds `firm.settings`.
- **Q3 — yes:** machine keys (x-api-key) keep bypassing role gates until
  Phase B, including the new A4 app-settings gate. Documented status quo,
  not an accident: §3.6.

- **Q4 — yes (2026-10-14):** entitlement admin lives inside the CFG-3 firm
  tab (ONE surface). Non-cosmetic editor on the settings arc's surface —
  coordinate via `admin_surface_coord` when that slice is cut.
