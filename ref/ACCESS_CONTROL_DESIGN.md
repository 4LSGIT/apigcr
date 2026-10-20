# Access Control — Design (ratified 2026-10-14; living doc)

Status: **RATIFIED 2026-10-14** (Q1–Q4 ruled; Fred's go in session).
Canonical home: this file. The pre-ratification draft lived in local/
(gitignored).
Manager state: scratch `fred/access_control_state`. Coordination:
`fred/admin_surface_coord`.

Every claim in §1–§5.7 verified 2026-10-14 against the live DB (RO key) and
actual source — including where it contradicts the arc's boot prompt. Later
additions carry their own date (§5.8–§5.10: 2026-10-15, source + the 8.4 twin;
§2.6's firm-id vocabulary and §8 Q4's shipped editor: 2026-10-16, source —
ui-custom S3.4; §5.7's two Ask Casey tables in SENSITIVE_TABLES and the
validator word-scan note: 2026-10-21, source — validator-containment arc).

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
| `it` | firm technical operator | **all firm-grade capabilities** (incl. `firm.settings` — Q2 yes — and `system.settings`), never root-grade |
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

`system.settings` (settings arc, 2026-10) is firm-grade but deliberately NOT
in `admin`'s bundle: a firm admin edits the firm's settings (Config → Firm);
IT edits the system's (Config → System — deployment switches, integration
wiring, alert thresholds).

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
  `comms.read_all`, `archives.purge`, `automations.manage`, and — from the
  settings arc — `system.settings`. Growing it = a
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
  extracts, plus firm launcher item ids `firm:<slug>` (ui-custom S3.4); this
  arc owns the table + resolver, ui-custom consumes the denied set when it
  builds the launcher. Cosmetic firm/user hide stays in
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
   by `firm.settings` (Config → Firm). Since the settings arc the gate is
   per KEY: `lib/settingsRegistry.js` gives each app_settings key one editor
   home, and the home names the capability — firm / portal / config homes
   write with `firm.settings`, cta with `system.settings` (all four read by
   any staff); system / comms read AND write with `system.settings`; secrets,
   interim access lists and retired keys are never served. A row's
   `is_editable` governs only UNREGISTERED rows (automation variables);
   `is_secret` still hides a row whatever the registry says.
4. **Launcher resolution order: registry → firm → role → user.** The role
   step is additive later (ui-custom S3 ships firm+user with the role
   column sentinel-reserved); entitlement denies overlay the result and
   deny wins; `moreSettings`/`helpSupport` undeniable.
5. Entitlement storage/resolve is owned by THIS arc (§2.6); ui-custom
   consumes `denied[]`; settings arc consumes the gate (§3.2–3).
6. Machine callers (x-api-key) bypass role gates. A key with NULL scopes
   also passes every capability gate (Q3); a scoped key passes only the
   capabilities its scopes name (Phase B, B2 — §5.2).

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

- **Surface scopes** (session keys): `sql.ro`, `sql.ro.sensitive` (§5.7),
  `scratch`, `alert`, `temp.clio`, `temp.dropbox`, `temp.ringcentral`,
  `temp.zohosign`. Each
  auth.readonly-mounted route declares its surface; `keyAllows(auth,
  scope)` enforces. New session-key mints default to
  `["sql.ro","scratch","alert"]` — the documented trio; `temp.*` becomes
  an explicit grant.
- **Route scopes** (machine keys): `route:/process-jobs`,
  `route:/mailbox-ingest` — enforced in jwtOrApiKey when the key row
  carries scopes (B2, `routeAllowed`): `route:/p` reaches `p` and `p/…`,
  never a sibling (`/process-jobs-evil`); case-insensitive, trailing slash
  and query ignored, dot segments (plain or %-encoded) refused. Off its
  routes a scoped key gets 403 `{ error, path }`, audited
  `forbidden_scope` under its label (403, not 401: the key is known).
  The two Cloud Scheduler keys get exactly their one route each.
- **Capability scopes** (machine keys): the §2.3 registry names. A scoped
  yck_ key no longer blanket-passes `can()` / requireAuth's allowApiKey
  path — it passes only the capabilities it carries. **This is how the Q3
  machine-trust bypass retires**: per key, as each key gets scoped, with
  NULL keys keeping today's behavior until touched. A capability-gated
  `requireAuth({ can, allowApiKey })` mount judges a scoped key by its
  capability alone (no route scope needed — and a route scope never stands
  in for the capability); roles gates and plain jwtOrApiKey routes judge it
  by route. The internal yci_ key carries no scopes and is untouched.
  Mints (B2): `POST /api/api-keys` takes `scopes` (route + capability
  names; session-key surface names refused); omitted = NULL.
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

### 5.7 Sensitive-read tier + content tables (RATIFIED 2026-10-14, incl. the stated audit-table limitation)

Prompted by the jwt_api_audit_log deny (B2 landing) and two findings routed
here the same day: ai_calls stores `request_excerpt` + full `response` for
every AI consumer (client content routes around comms_transcripts' deny;
COMM_ARC_MAN ruled `logContent:false` for their S3 — defense in depth,
kept), and Fred wants audit/diagnostic questions to stop routing through
him and the SU console.

**Two-tier deny in lib/sqlGuard:**
- `SECRET_TABLES` (absolute — no key ever reads them): `app_settings`,
  `email_ingest_sources`. These hold live credentials; row-level
  (`is_secret`) splits are not expressible in a statement-regex guard, so
  the whole store stays SU-console-only.
- `SENSITIVE_TABLES` (readable ONLY under the new scope):
  `jwt_api_audit_log`, `ai_calls`, `comms_transcripts`,
  `comms_no_transcribe`, `comms_summary_guides`, `admin_audit_log`,
  `readonly_query_log`, `assistant_chats`, `assistant_chat_messages`.
  Content tables: client communications, AI prompts/replies, staff notes on
  calls (comms archive S3c), console query texts, other sessions' SQL, and
  (added with the validator-containment arc, 2026-10-21) Ask Casey chats —
  each chat holds the verbatim evidence rows the assistant read plus its
  answers, owner-scoped in the app but not on the RO endpoint. The report +
  assistant SQL validator also refuses every name in this tier (and SECRET)
  as a word anywhere in the statement — lib/reportSchema/validator.js sources
  the lists from here, never re-listing them.
- **`ai_spend` VIEW** (new, ordinary-readable): id, created_at,
  prompt_key, prompt_version, model, mode, output_type, consumer_ref,
  status, input_tokens, output_tokens, cost_cents, latency_ms — spend
  monitoring keeps working for every ordinary session; only `error`,
  `request_excerpt`, `response` leave the ordinary surface. (The view name
  deliberately does not contain "ai_calls": the guard's \b-regex would not
  match it anyway, but names should not rely on regex subtleties.)

**The `sql.ro.sensitive` scope** (rides the B1 scopes machinery):
- Never in DEFAULT_SCOPES; mintable only via the SU session-keys pane
  (already SU-gated) with its own explicit warning + confirm.
- Keys carrying it are mint-time capped at a SHORT expiry (24h max;
  default 4h) — the mint rejects longer.
- /api/readonly/sql: a key with the scope passes SENSITIVE_TABLES;
  SECRET_TABLES still refuse. Everything else unchanged.
- Audit: readonly_query_log already captures every query + key id; rows
  from sensitive-scoped keys are flagged. HONEST LIMITATION, Fred to
  accept or reject: a sensitive key can read readonly_query_log /
  admin_audit_log (they are in SENSITIVE, which it holds) — perfect
  "can't read its own audit" isolation would need a third tier; at one
  SU minting short-lived keys for his own diagnostic sessions, that tier
  is not obviously worth its complexity.

**Slices:** SEC-3 = ai_spend view (migration) + the two-tier guard split +
SENSITIVE_TABLES + scope enforcement + mint cap + pane warning + tests.
Small; after SEC-2 lands (sqlGuard + readonlyKeys files overlap).

### 5.8 Delegated session keys (D1, Fred's go 2026-10-15)

A **manager key** — a session key holding `keys.mint` — mints, lists and
revokes its OWN child session keys to hand to worker sessions, without a
round-trip through the SU pane. Delegation adds identities, never power.

- **The scope.** `keys.mint` is a surface scope, `explicit` (a legacy
  NULL-scopes key does not hold it). Only the SU mints it, through the
  ordinary session-key POST and its server-fed picker; it may sit beside
  `sql.ro.sensitive`, whose 24h cap applies unchanged.
- **Endpoints** (session-key authed + `requireKeyScope('keys.mint')`):
  `POST /api/readonly-keys/children {label, ttlMinutes?, scopes?}` →
  `{id, key, expiresAt, scopes}` (plaintext once); `GET …/children` (own
  only); `DELETE …/children/:id` (own only — another key's child is a 404,
  never a 403: existence is not confirmed). The paths never collide with
  the SU `/:id`, `/:id/log` routes (different segment counts; registered
  first anyway).
- **Child scopes** ⊆ `CHILD_SCOPES` (`sql.ro`, `scratch`, `alert`) ∩ the
  parent's. Never `keys.mint` (no chains), `sql.ro.sensitive`, `temp.*`,
  route or capability scopes. Omitted → the whole intersection (empty → 400);
  anything outside → 400 naming it. Never a silent drop.
- **Child TTL** ≤ 24h AND ≤ the parent's expiry; omitted → the smaller;
  over either → 400 (fail loud, never clamp). Stored to the whole second.
- **Rate**: 10 mints per rolling hour per parent, counted in the DB under a
  row lock on the parent (exact under concurrency; Cloud Run runs several
  instances) → 429. No cap on live children.
- **Cascade at auth time** (lib/auth.readonly, one SELECT joining the
  parent): parent revoked or missing → 401 `rejected_parent_revoked`;
  parent expired → 401 `rejected_parent_expired`; audited like the other
  rejects; nothing is written to the child's row (no sweep). Effective child
  scopes = `childEffectiveScopes` = own ∩ CHILD_SCOPES ∩ the parent's,
  recomputed per request — narrowing a parent narrows its children at once,
  and a tampered child row cannot carry anything past the trio.
- **Budgets per identity root**: `req.auth.rootKeyId` (the parent's id for a
  child, its own otherwise). The IT-alert 10/h limit keys on it, so children
  never multiply it.
- **Provenance**: `readonly_api_keys.parent_key_id` (nullable, indexed with
  created_at, FK ON DELETE **RESTRICT** — CASCADE would silently delete
  children and their query logs, SET NULL would promote them to roots that
  no longer die with their parent). Child `created_by` = the parent's. Every
  child mint / revoke → admin_audit_log (tool `readonlyKeys`, userId null,
  details parentKeyId / childKeyId / scopes / expiresAt; never the plaintext).
- **SU pane**: a Parent column; a child of a dead parent reads dead
  ("parent revoked" / "parent expired") and drops out of active-only.
- **Deploy order**: `scripts/accessD1ParentKey.js` stage 1 (ADD) before the
  backend — the D1 auth SELECT names parent_key_id and fails CLOSED (500)
  without it. Rolling the backend back after children exist: revoke them
  first (the old auth would treat a child as a root key until its own ≤24h
  expiry).

**`ip_allowlist` retired (D1, Fred's ruling 2026-10-15).** The column was
stored at mint and enforced nowhere, so its holders believed in a
restriction that did not exist. The mint refuses `ipAllowlist` (400, so no
caller keeps believing in it), the pane lost the field, and the column is
dropped by stage 2 of the same script — AFTER the deploy, the reverse of
stage 1, because the pre-D1 backend's mint and list name it. Session keys
are not IP-restricted; if that is ever wanted, it is a new, enforced design.

### 5.9 Editing scopes and expiry (D2, Fred's go 2026-10-15)

A key's scopes and expiry are no longer frozen at mint. **Revocation stays
terminal**: every edit or renew of a revoked key is a 409 ("revoked keys stay
revoked — mint a new one"), and there is no un-revoke anywhere. No schema
change. Every edit / renew lands in admin_audit_log with BEFORE and AFTER
(tool = the pane's tag: `readonlyKeys` / `api_keys`), never the plaintext.

- **One copy of the rules.** Edit and renew call the mint's own validators —
  session keys: `sessionScopes` / `rootTtlMinutes` / `childExpiresAt` /
  `childScopesWithin` (routes/api.readonlyKeys.js); machine keys:
  `machineKeyScopes` / `machineKeyExpiry` (lib/apiKeys). An unknown scope is
  a 400. **Legacy is a state you leave, never enter**: a NULL-scopes key may
  be given scopes (the retrofit); no key is ever set back to NULL.
- **Session keys** (SU): `PATCH /api/readonly-keys/:id {scopes}` — a full
  replace. Adding `sql.ro.sensitive` to a key with more than 24h left is a
  400 that names the renew route (renew shorter first). A child's scopes
  stay within the trio. Editing a parent never writes its children: D1's
  per-request intersection narrows them; removing `keys.mint` leaves them
  alive without a manager (the reply says how many), still dying with it.
  `POST /api/readonly-keys/:id/renew {ttlMinutes?}` — now + ttl within the
  MINT caps for the key's kind (ordinary ≤ 3d default 1d, sensitive ≤ 24h
  default 4h, child ≤ 24h and ≤ the parent, default the smaller); over a cap
  is a 400, never a clamp (the mint itself still clamps an ordinary over-long
  ask, as it always has). Works on an expired key; a child of a revoked
  parent is a 409 (dead for good).
- **A manager renews its own children**: `POST
  /api/readonly-keys/children/:id/renew` (keys.mint) within the child caps.
  Foreign, missing or its own id → 404; a child can renew nothing.
- **The advisory stamp** in a renewed key's plaintext goes stale; renew
  replies carry `expiresStamp` so the holder can rewrite its suffix. The DB
  is the truth, as ever.
- **Machine keys** (SU): `PATCH /api/api-keys/:id {scopes}` (B2 rules) and
  `POST /api/api-keys/:id/expiry {ttlMinutes} | {never:true}` (B6 rules;
  exactly one — an omitted ttl is a 400, never a silent "never"). Both call
  invalidateCache() on the serving instance; other instances converge within
  the 60s lookup cache, like revocation — including the OLD expiry the cache
  carries, so a key renewed after it lapsed may stay refused there ≤60s.
  The internal `yci_` key is out of scope.
- **Panes**: per-row "scopes" and "renew" / "expiry" dialogs (the existing
  pickers, server-fed), never on a revoked row nor — in the session pane — a
  child of a dead parent. A child's picker is the trio; a legacy key's
  dialog starts from its legacy surface, so saving unchanged changes nothing.
- Keys are not a sync-bus entity (no yc-sync MATCHER covers either family).

### 5.10 Session-key tasks — the first app-table write (D3, Fred's go 2026-10-15)

**The line this crosses, and why.** Until D3 a session key reached read-only
SQL, scratch notes and IT alerts: nothing a key did changed the firm's own
records. `tasks.own` is the first scope that writes an app table. The reason:
AI manager sessions hand Fred and staff work items directly — a task in the
assignee's list, with its email and reminders — instead of through chat,
where they get lost. The boundary is kept narrow on purpose: one table, one
scope, and the key manages only what it created.

- **The scope.** `tasks.own`, surface, `explicit` (legacy NULL keys lack
  it), NOT in CHILD_SCOPES (no child ever holds it — dropped even from a
  tampered child row). SU-minted through the picker; D2's edit can add it.
- **Ownership is a real column**: `tasks.task_session_key_id` (int NULL,
  indexed with task_date) — never `task_source`, which is free text any
  caller can set. The key that creates a task owns it; any other task (made
  in the app, or by another key) is a 404 on every verb — existence is never
  confirmed. No FK to readonly_api_keys: on the hot table an FK adds a
  parent lookup + shared lock to every keyed INSERT, and ownership needs
  only equality (key ids are never reused).
- **Endpoints** (`readonlyApiKeyAuth, requireKeyScope('tasks.own')`; the
  jwtOrApiKey `/api/tasks*` routes untouched): `POST /api/key-tasks`,
  `GET /api/key-tasks`, `GET|PATCH /api/key-tasks/:id`, `PATCH
  …/:id/complete|reopen|delete`. All through services/taskService (no
  parallel task SQL); reassigning (`to`) is transferTask. Bodies are closed:
  an unknown field is a 400.
- **Assignee** = any ACTIVE STAFF user — `taskService.findAssignableStaff`,
  the app's own predicate (list_users' defaults: `user_auth LIKE
  'authorized%'`, the login gate, AND `user_type <> 0`, the task-assignee
  picker's filter, which drops Automation 0). Anyone else → 400. The same
  `active` now rides each /api/firm-data user row, so the in-app assignee
  pickers offer only active staff too (lists and name lookups still see
  everyone — see AI_CONTEXT §18).
- **Attribution**: task_from = the key's created_by (the SU who minted it);
  task_source = `session_key:<keyId>` (labelled "Session key #N"); every
  task_log row these routes write carries `{ via: 'session_key', keyId }`
  (history reads "… via session key #N"); log `by` = task_from. No
  admin_audit_log row — task_log is the record.
- **Assignment email** on by default (taskService's); `send_assignment_email:
  false` turns it off. **Completion email** (`notify` → task_notification)
  DEFAULT TRUE (Fred, 2026-10-15): completing the task emails task_from, the
  key's minter; `notify:false` turns it off; PATCH may change it.
- **Create limit**: 20 per rolling hour per ROOT key (`req.auth.rootKeyId`;
  a child's rows count toward it), DB-counted under a per-root named lock
  (GET_LOCK) so concurrent creates cannot overshoot. Edits unlimited.
- **The action token** (task_action_token / action_url) is never returned:
  it is the assignee's one-click bearer.
- **Sync bus**: not registered — `/api/tasks*` has no yc-sync MATCHER either
  (tasks are not a bus entity today), and key callers are sessions, not
  browser frames. Reported to the arc manager rather than invented.
- **Deploy order**: `scripts/accessD3TaskSessionKey.js` (column INSTANT,
  index INPLACE/LOCK=NONE) before the backend — the key routes name the
  column and fail CLOSED (500, nothing written) without it; every other task
  path is untouched on either schema (createTask names the column only for a
  key's task).

### 5.6 Slice plan — Phase B (post-ratification)

- **B1** `scopes` column (both tables, one migration) + `keyAllows()` +
  surface enforcement on every auth.readonly route; new-mint defaults.
  NULL=legacy throughout. Unblocks everything else.
- **B2** Machine-key scoping: route scopes on the two scheduler keys
  (mint fresh scoped keys, swap in the job configs, revoke old — the
  INFRA_GCP §10 runbook pattern); capability scopes in the api-keys admin
  UI; retire Q3 per scoped key.
- **B3** base62 mint format + UI copy ("session key" rename lands here).
- **B6** (shipped 2026-10-15, post-close addendum): machine-key scope
  picker (server-fed; live router walk for route families, bare /api
  never offered) + optional api_keys.expires_at (NULL = never; cache
  re-checks expiry every hit; set at mint, editable since D2, junk TTL
  refused).
- **D1** (2026-10-15) Delegated session keys — `keys.mint`, the /children
  endpoints, the auth-time cascade, root-keyed alert budget (§5.8); plus
  the ip_allowlist retirement. Migration in two stages around the deploy.
- **D2** (2026-10-15) Edit scopes + renew expiry on both key families
  (§5.9). No schema change.
- **D3** (2026-10-15) `tasks.own` + `/api/key-tasks` — the first app-table
  write a session key makes (§5.10). Migration: tasks.task_session_key_id.
  Follow-ups: key tasks email the minter on completion (`notify`, default
  on); firmData users carry a boolean `active`; tasks.html assignee pickers
  offer active staff only.
- **D3b** (2026-10-15) The other assign pickers (appt / event / reminder /
  checklists / CTA / automation) offer active users only; a stored value is
  always kept, whatever filter would drop it (AI_CONTEXT §18). Comms'
  task-to picker is the comms arc's to follow.
- **B4** Secrets: hooks.auth_config + credentials.config secret values
  encrypted at rest (code first, then the data script — §5.5);
  pre-commit secret scan. (Hygiene sitting rides whenever Fred has 10
  minutes.)
- **B5** `/api/hooks` management routes behind
  `requireAuth({ can: 'automations.manage', allowApiKey: true })`
  (the receiver `/hooks/:slug` untouched) — 17 routes. Two reads stay
  on jwtOrApiKey by ruling (2026-10-14): the LIST, because the booking-
  views picker reads it (a 403 would empty the picker and the next save
  would clear a view's hook) — non-holders get rows without
  auth_config / filter_config / transform_config / captured_sample; and
  the GLOBAL executions feed of the Automation Activity tab (explicit
  columns, no payloads). The per-hook execution routes are gated.
  automations.manage gates only hooks for now; workflows / sequences /
  triggers management joining it is a later conversation.

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
  tab (ONE surface). It shipped in ui-custom S3.4 as that tab's "Who sees
  what" section: per-USER denies only. Role scoping is NOT role denies (a
  deny hits everyone holding the role and nobody bypasses it) but the firm
  ui_config `visible_to` allow-list, su implicit (Fred, 2026-10-16); role /
  firm deny scopes stay API-only.
