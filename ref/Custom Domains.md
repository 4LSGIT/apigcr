by Mr G.

---

# Plan: Custom Domains + Cloudflare Architecture for 4LSG Landing Pages

## Context

We run a single Cloud Run service that currently serves:

- `app.4lsg.com` → authenticated main application
- `4lsg.com` → public-facing pages (landing pages, booking, CTAs, campaigns) served at paths like `/p/{slug}`

Landing pages are HTML documents stored in the database and rendered dynamically.

**Goal:** Allow clients to point their own domains (e.g. `bk4u.com`) at a specific landing page, with the process being fully self-service (no manual intervention from us). Also improve the overall domain and security architecture.

## High-Level Architecture Decision

Put **everything** behind Cloudflare:

| Domain / Type              | Purpose                              | Cloudflare Role                          | Backend Behavior |
|---------------------------|--------------------------------------|------------------------------------------|------------------|
| `4lsg.com` / `www.4lsg.com` | Public landing pages & marketing     | Proxied + SSL                            | Serve public content based on path + host |
| `app.4lsg.com`             | Authenticated application            | Proxied + stricter security rules         | Full app with auth |
| Customer custom domains (e.g. `bk4u.com`) | Client-branded landing pages | Cloudflare for SaaS (Custom Hostnames) | Look up host → serve corresponding landing page |

All traffic ultimately hits the **same Cloud Run service**. Routing decisions are made inside the application based on the `Host` header.

## Why Cloudflare (not native Cloud Run Domain Mapping)

- Native Cloud Run domain mappings are still in Preview and not recommended for production.
- They require manual creation of a mapping for every single domain.
- No good support for high volumes of customer domains.
- Cloudflare for SaaS gives automatic SSL, validation, and self-service capability at very low cost ($0.10 per hostname after the first 100).

## Required Capabilities

### 1. Self-Service Custom Domain Flow

Client (inside `app.4lsg.com`) should be able to:

1. Select a landing page
2. Enter a domain they own (e.g. `bk4u.com` or `www.bk4u.com`)
3. See the exact DNS records they need to add
4. See live status: Pending → Validating → Active / Failed
5. Remove or change the domain later

We should never need to manually create anything in Cloudflare or Cloud Run for a normal customer domain.

### 2. Application Routing Logic

On every request the service should:

```
host = request.hostname.toLowerCase()

if host is "app.4lsg.com":
    → serve authenticated application

else if host is "4lsg.com" or "www.4lsg.com":
    → serve normal public routes (including /p/:slug)

else:
    → look up host in custom_domains table
    → if found and verified → serve the linked landing page (usually at root /)
    → else → 404 or friendly error
```

### 3. Data Model Additions

Suggested minimal schema:

```sql
-- Option A: simple column on existing pages table
ALTER TABLE landing_pages
  ADD COLUMN custom_domain VARCHAR(255) NULL UNIQUE,
  ADD COLUMN custom_domain_status VARCHAR(50) DEFAULT 'none', -- none, pending, active, failed
  ADD COLUMN custom_domain_cf_id VARCHAR(100) NULL,          -- Cloudflare custom hostname ID
  ADD COLUMN custom_domain_verified_at TIMESTAMP NULL;

-- Option B (preferred for flexibility): separate table
CREATE TABLE page_custom_domains (
  id UUID PRIMARY KEY,
  page_id UUID NOT NULL REFERENCES landing_pages(id),
  domain VARCHAR(255) NOT NULL UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  cloudflare_hostname_id VARCHAR(100),
  verification_errors JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  verified_at TIMESTAMP
);
```

### 4. Cloudflare Setup

- Create a Cloudflare zone for `4lsg.com` (if not already done).
- Proxy `4lsg.com`, `www.4lsg.com`, and `app.4lsg.com`.
- Enable **Cloudflare for SaaS** on the zone.
- Decide on a fallback origin (usually the Cloud Run URL or a stable CNAME target like `origin.4lsg.com`).
- Use Custom Hostnames API for customer domains.

### 5. Implementation Steps (for execution)

1. **Infrastructure**
   - Move `4lsg.com` and `app.4lsg.com` behind Cloudflare (DNS + proxy).
   - Enable Cloudflare for SaaS.
   - Create a stable origin (CNAME or direct Cloud Run).

2. **Backend**
   - Add data model for custom domains.
   - Implement host-based routing middleware (early in the request pipeline).
   - Build Cloudflare API client (create / get / delete custom hostname + status polling).
   - Add endpoints for the admin UI:
     - `POST /api/pages/:id/custom-domain`
     - `GET /api/pages/:id/custom-domain`
     - `DELETE /api/pages/:id/custom-domain`

3. **Frontend (app.4lsg.com)**
   - Add “Custom Domain” section on the landing page settings.
   - Show required DNS records (CNAME + TXT).
   - Poll or use webhooks for status updates.
   - Clear error messaging when validation fails.

4. **Security & Hardening**
   - Different Cloudflare WAF / rate-limit rules for `app.4lsg.com` vs public domains.
   - Keep the existing strict public-surface rules (no auth cookies on public hosts, tight CSP, etc.).
   - Validate that a domain is not already claimed by another page/account.

5. **Edge Cases to Handle**
   - Apex domain vs `www`
   - Domain already in use
   - Customer removes DNS records later
   - Certificate provisioning delays
   - Multiple domains pointing at the same page (optional future)

## Success Criteria

- A client can connect their own domain to a landing page without any manual action from us.
- Visiting the custom domain serves the correct landing page with a valid SSL certificate.
- `app.4lsg.com` and `4lsg.com` continue to work correctly (and preferably with improved security/performance via Cloudflare).
- The system can scale to hundreds of custom domains without operational burden.

## Open Questions / Decisions Needed

- Prefer apex domains (`bk4u.com`) or force `www`?
- Allow multiple custom domains per landing page?
- Exact Cloudflare plan (Free/Pro is usually enough to start)?
- Do we want Cloudflare Workers in front for any extra logic, or keep everything in the Node service?

---