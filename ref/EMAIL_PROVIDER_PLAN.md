# EMAIL_PROVIDER_PLAN

Status: DRAFT v1 — 2026-10-08. For review/refinement; execution gated per stage.
Scope: move firm email off SiteGround onto Migadu; 4lsg.com cutover gated separately.
Related: `ref/MAILBOX_SYSTEM_DESIGN.md` (YC mailbox subsystem — stage S2 here), DB→Cloud SQL plan (separate), sites→Cloudflare (separate, one site remaining).

## 1. Decision

Single provider target: **Migadu** (flat-rate, unlimited mailboxes/domains, admin API, IMAP/SMTP, wildcard send-as). Start **Mini ($90/yr)**, upgrade to Standard ($290/yr) on volume pressure — upgrade is instant.

Rejected: CloudWish/Mailbux (opaque operator, affiliate-farm reviews), Purelymail (too small for client-facing law mail), Zoho/M365/Fastmail (per-seat pricing defeats the many-mailbox goal; M365 is the fallback if we ever want native shared mailboxes with zero build), MXroute (credible budget rival, but no real provisioning API), keep-Workspace-per-seat (cost + the shared-single-seat model is the thing we're escaping).

Standing rules adopted:
- **Bulk rule:** any send over ~50 recipients goes through a transactional provider (SES, or revived MailerSend) on a subdomain — never through the mailbox host (Migadu ToS is anti-bulk; also true of Gmail).
- **Mailbox host ≠ send path.** Clients and YC can route outbound SMTP independently of where mail is stored. This is the escape hatch for the Microsoft risk (§5).

## 2. Current state (verified 2026-10-06/08)

- **Workspace:** ONE paid seat on 4lsg.com, shared by all staff via send-as aliases. Holds Google Calendar (CAL arc, `user_gcal_id`), OAuth credentials, Apps Script ingest (`gmail-firm`, ingest source 1, active).
- **SiteGround:** mailboxes on mdbl (10–20, mostly inactive; active: shoshana@, stuart@ receives heavy traffic, info@, IT@), mdlit, lsg. SG SMTP host `gcam1191.siteground.biz:587` used by `email_credentials` rows 4 (IT@mdbl) and 6 (shoshana@mdbl). Exim pipe ingest (source 2 `siteground-php`) **dead since 2026-05-27** — Apps Script carries all ingest; pipe is not a cutover blocker.
- **email_credentials:** 9 rows `provider='gmail'` (ids 1,2,3,5,7,12,14,15,16 — all aliases of the one Workspace account), 2 rows `provider='smtp'` (4, 6 → SG).
- **DNS:**
  - 4lsg.com (Namecheap DNS): SPF `include:_spf.google.com include:_spf.mailersend.net ~all` (mailersend = dead test, to be removed); Google DKIM live; DMARC record **currently at the wrong name** `_dmarc.4lsg.com.4lsg.com` — Namecheap Host field must be `_dmarc` only. Fix + verify is S0.
  - mdbl (Cloudflare): SPF include-only SG relay; DMARC `p=quarantine pct=25` live 2026-10-01, ramp scheduled ~10-15 (scratch `followups/2026-10-15_mdbl-dmarc-ramp`).
  - **mdlit: nameservers still on SiteGround** — must move to Cloudflare before SG cancellation.
  - lsg: Cloudflare.

## 3. Measured baselines (don't re-derive)

- Outbound via YC: ~12/day avg, **45/day peak**, 16/hr peak (9am workflow burst). Gmail-UI sends invisible to log; assume <100/day firm-wide worst case.
- Campaigns: 72 email campaigns ever, 124 total recipients, **max 12 recipients** — mail-merge usage, not bulk. No ToS conflict at this profile.
- Recipient mix (180d, 2,054 addrs): **61% Google** (clients on gmail), **15% Microsoft** (det13ksc, det13, eymgroup, woodkull, cohenlerner, mercierlegal, paletzlaw, rcrfirm, michigan.gov, hotmail — i.e. trustees + local bar), 24% other/own-MX (uscourts.gov, usdoj.gov, yahoo, icloud).
- Migadu caps: Mini 100 out/day, 200 in/day account-wide; incoming over cap deferred to next day, outgoing refused at submission, **every attempt counted**; `smtp.js` logs FAILED and rethrows (no retry loop, no resume queue).

## 4. Microsoft deliverability risk (gate for S3)

MS junk-folders/silently drops mail from small-provider shared IPs regardless of content tests; worst for first contact, mildest for established bidirectional correspondents. Our MS-hosted 15% is exactly the trustees and opposing counsel — highest-stakes mail. Mitigation: S1 doubles as a live trial; S3 does not proceed until the first-contact test passes OR we adopt the split send path (store on Migadu, send via Google relay/SES for humans or for MS-bound recipients).

## 5. Stages

### S0 — prep (no provider change)
- [ ] Fix `_dmarc` Host field in Namecheap; verify `_dmarc.4lsg.com` resolves (`p=none; rua=mailto:it@4lsg.com; fo=1`).
- [ ] Watch 4lsg DMARC reports ~1 week (dmarcSummary GAS); then drop mailersend SPF include if zero traffic.
- [ ] Move mdlit nameservers to Cloudflare; drop MX TTLs to 300.
- [ ] SG inventory: all mailboxes + sizes, forwarders, filters, autoresponders, per domain; check whether any domain is REGISTERED at SG (transfer out before cancel); check how stuart@mdbl currently reaches Gmail (assumed SG forwarder).
- [ ] mdbl DMARC ramp (10-15): proceed per existing plan, but DO NOT go p=reject before/during MX cutover — the report basis (SG relay IPs) becomes obsolete at cutover; restart observation after.

### S1 — Migadu Mini, SiteGround domains
- [ ] Create Migadu account (Mini), add mdbl, mdlit, lsg; publish per-domain DNS from admin panel (MX, SPF, DKIM, autoconfig/autodiscover).
- [ ] Mailboxes: real ones only for active users; one `archive@mdbl` box; everything dead becomes alias or dies.
- [ ] imapsync (Docker, local or YC server; NOT the hosted web version): pre-sync all boxes from `gcam1191.siteground.biz:993` → `imap.migadu.com:993`; dead accounts → `archive@` with `--subfolder2 <name>`; `--automap`; `--dry` first.
- [ ] Flip MX per domain. Re-run imapsync for delta. Catch-all → TBD (open question) for one quarter.
- [ ] Update `email_credentials` 4 + 6 → `smtp.migadu.com:465` (or one wildcard-send identity per domain).
- [ ] Deactivate ingest source 2 (`siteground-php`); delete PHP relay from SG.
- [ ] Client setup: SB Outlook (classic, direct IMAP — avoid "New Outlook" MS-cloud sync), SS Apple Mail.
- [ ] **MS first-contact test:** fresh outlook.com box + one friendly O365 counterparty; send from migrated mdbl addresses; record inbox vs junk vs vanish. This result gates S3.
- [ ] One quiet billing cycle → cancel SiteGround (after DB + last site are also off — coordinate).

### S2 — YC mailbox system
See `ref/MAILBOX_SYSTEM_DESIGN.md`. Includes IMAP ingest worker (eventual Apps Script replacement), grants/views, send guardrails (per-credential daily budget, `bulk_ok` flag).

### S3 — 4lsg.com cutover (GATED)
Gates: (a) MS test passed or split-path accepted; (b) IMAP ingest worker live (Apps Script ingest dies with the inbox move); (c) calendar dependency resolved — keep the one Workspace seat for Google Calendar + OAuth (it keeps sending/calendar even with MX elsewhere).
- [ ] Personal Migadu mailboxes for all staff; 9 gmail credential rows collapse toward wildcard identities.
- [ ] 4lsg SPF/DKIM: dual-sender (Google + Migadu) during transition; prune after.
- [ ] MX flip + delta imapsync of the shared account (via Gmail IMAP) if history should move.
Rollback: MX flips are reversible at 300s TTL; imapsync re-runs are idempotent.

## 6. Cost

Mini $90/yr (→ Standard $290 if: all-firm outbound regularly >100/day, or archive pushes past ~30GB soft). Replaces SG email portion of $360–540/yr. Workspace stays 1 seat (~$84/yr) for calendar/OAuth. Transactional (bulk rule): SES ~$0.10/1k as needed.

## 7. Open questions (refine before S1)

1. Which staff are active and get real mailboxes: SB (Shoshana), Charmaine, Valerie, Rivka — who still works at the firm?
2. Catch-all target for mdbl during transition quarter (archive@ vs a monitored box)?
3. Archive retention policy for dead-mailbox history (keep forever in archive@? export mbox offline too?).
4. Who owns the O365 side of the MS test (friendly counterparty vs trial tenant)?
5. Long-term: keep the Workspace seat indefinitely for Calendar, or plan a calendar exit too (separate arc)?
6. Transactional provider for the bulk rule: SES vs reviving MailerSend (account may still exist).
