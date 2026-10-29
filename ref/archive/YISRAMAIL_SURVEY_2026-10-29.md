# YisraMail — provider & builder survey (2026-10-29)

Dated market survey that fed `ref/YISRAMAIL_DESIGN.md` decisions D6 (Amazon SES)
and D9 (GrapesJS + grapesjs-mjml), both ruled 2026-10-29. Archived as written;
prices are as fetched that day — re-check before relying on any figure.

## Appendix A — Bulk transport survey (official pricing/docs pages, fetched 2026-10-29)

Prices move; re-check before signing up. "Own headers" = we may set our own
`List-Unsubscribe` + `List-Unsubscribe-Post` on marketing mail.

| Provider | Free (month / day) | Plan covering 5k/mo + a 2k day | @10k | @50k | Marketing OK | Own headers | Webhooks signed | Tenant isolation |
|---|---|---|---|---|---|---|---|---|
| **Amazon SES** | sandbox 200/day; $200 AWS credit 6 mo | $0.10/1k → ≈ $0.50 | $1 | $5 | yes, after production-access review | yes | yes (SNS SHA256) / EventBridge | **Tenants** (reputation + auto-pause, API) |
| Resend | 3k / 100 per day | Pro $20 (50k) | $20 | $20 | yes (opt-in) | yes (`/emails`) | yes (Svix) | none (domain-scoped keys) |
| Mailgun | 100/day | Basic $15 (10k) | $15 | $35 | yes (provable opt-in) | yes | yes (HMAC) | sub-accounts not self-serve |
| SendGrid | 60-day trial, 100/day | Essentials $19.95 (50k) | $19.95 | $19.95 | yes | yes | yes (ECDSA) | subusers Pro+ |
| Postmark | 100/mo | Basic $15 (10k) | $15 | $55–66 | Broadcast stream, vetted | needs support approval; Broadcast adds its own | **no** | Servers + Domains API |
| MailerSend | 500/mo | Hobby $7 (5k; 1,000 req/day incl. SMTP) | ≈ $14.50 / $35 | $35 | yes | only Professional $110 | yes (HMAC) | none found |
| Brevo (API) | 300/day | Starter $9 (5k) | $17 | $56 | yes | unverified one-click | unverified | unverified |
| Mailjet | 6k / 200 per day | Starter $9 (8k) | $19 | $40–59 | yes | yes | **no** | 1–20 sub-accounts |
| SMTP2GO | 1k / 200 per day | Starter $10 (10k) | $10 | $75 | 100 % opt-in | unverified | **no** | sub-accounts |
| Mailtrap | 4k / 150 per day | Basic $15 (10k) | $15 | $20 | Bulk Stream | Bulk Stream adds them | yes (HMAC) | unverified |
| Elastic Email | 3k/mo | Starter $19 (50k) | $19 | $19 | with consent | forced own unsubscribe link | unverified | Pro $49 |
| Bird (ex-SparkPost) | 1k / 50 per day | $15 deposit, $0.40/1k | $15 | ≈ $20 | yes | **rejected (422)** | yes | workspaces |
| ZeptoMail / Cloudflare Email / Mandrill | — | — | — | — | **transactional only** | — | — | — |

All-in-one marketing platforms (~2,500 contacts, monthly sends): Brevo
Marketing ≈ $25 (+$12 no logo); MailerLite Comfort $33 / Power $49;
EmailOctopus Pro $20, or Connect $17 sending through your own SES; Sender.net
free tier covers 2.5k/15k; Mailchimp/Kit/Constant Contact prices unverified.
All but Constant Contact report unsubscribes by webhook.

Sources: aws.amazon.com/ses/pricing, docs.aws.amazon.com/ses (production
access, suppression list, tenants, event destinations), resend.com/pricing +
/legal/acceptable-use, mailgun.com/pricing + /legal/aup, twilio.com SendGrid
pricing, postmarkapp.com/pricing + message-streams + webhooks, mailersend.com/pricing
+ help/smtp-relay, brevo.com/pricing.md, mailjet.com/pricing, smtp2go.com/terms,
mailtrap.io/pricing, elasticemail.com/email-api-pricing, bird.com/pricing/email,
zoho.com/zeptomail/pricing, developers.cloudflare.com/email-service,
mailchimp.com/pricing/transactional-email, mailerlite.com/pricing, emailoctopus.com/pricing.

## Appendix B — Email builder survey (fetched 2026-10-29; npm registry, GitHub, vendor pricing pages)

| Candidate | License | Price (free / paid) | CDN, no build | Self-hosted | Client-side HTML+JSON | Merge tags | Upload hook | Health 2026 |
|---|---|---|---|---|---|---|---|---|
| **GrapesJS + grapesjs-mjml** | BSD-3 | free | yes | yes | yes (mjml-browser) | no picker (build one) | `uploadFile` | core 0.23.8 (10-15), mjml plugin active |
| GrapesJS + preset-newsletter | BSD-3 | free | yes | yes | yes (juice inline) | no picker | `uploadFile` | preset stale (2023) |
| Unlayer | commercial | Free / Launch $250 / Scale $750 / Optimize $2,000 per mo | yes | no (vendor iframe) | yes, unmetered | any syntax | Launch+ | active |
| Beefree SDK | commercial | Free (10 users) / $400 / $1,200 / $3,000 per mo | yes + server token | no | no (vendor renders) | Core+ "smart" | paid | active |
| Stripo Plugin | commercial | Free (100 emails/mo) / $100 / $550 | yes + server token | no (emails stored at Stripo) | partial | yes | all plans (GCS) | active |
| Topol Plugin | commercial | trial / $70 / $140 / $300 per mo + per-MAU | yes | no | no (vendor backend) | yes | Expansion+ | active |
| Chamaileon SDK | commercial | Free (10 MAU) / from $200 | yes + server token | no | no (metered generator) | via variables | `onEditImage` | active |
| GrapesJS Studio SDK | proprietary | Free (1k sessions, branding) / $200 / $2,000 | yes (UMD) | mostly (licence key) | yes | plugins | `onUpload` | active |
| Templatical | FSL-1.1-MIT / MIT renderer | free | yes (ESM) | yes | JSON+MJML; HTML needs MJML compiler | yes | `onRequestMedia` | very active; created 2026-03, pre-1.0, solo |
| Easy Email | MIT (Pro commercial) | free / Pro $199–499 | no (React 18) | yes | yes (MJML) | `mergeTags` | `onUploadImage` | moderate |
| EmailBuilder.js | MIT | free | no (React app to fork) | yes | yes | no | none | slow |
| Maily | MIT | free | no (React/Tiptap; not drag-drop canvas) | yes | via renderer | variable nodes | `onImageUpload` | moderate |
| Mosaico | GPL-3.0 | free | built dist | needs backend | yes | — | backend | low |
| MJML / react-email | MIT | free | — | — | rendering layers, not builders | | | active |

Sources: unlayer.com/pricing, developers.beefree.io/pricing-plans,
stripo.email/plugin, topol.io/pricing, chamaileon.io/sdk, grapesjs.com/sdk/pricing,
github.com/GrapesJS/grapesjs, github.com/GrapesJS/mjml, github.com/templatical/sdk,
easyemail.pro, github.com/usewaypoint/email-builder-js, github.com/arikchakma/maily.to.
