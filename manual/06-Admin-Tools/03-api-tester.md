# API Tester (SU)

Sends arbitrary HTTP requests **from the YisraCase server** and shows you the
response. Because the request originates server-side, it can use the firm's
stored credentials and reach systems that only trust our server.

**Where:** More → **API Tester**. SU only.

## What it's for

- **Bootstrapping external integrations** — e.g. registering a Clio or
  RingCentral webhook subscription.
- **Debugging YisraHook outbound deliveries** — replay a delivery from the
  delivery logs and watch the response.
- **Ad-hoc admin calls** against external systems using a stored credential.

## Using it

1. Pick the **method**, **URL**, **headers**, and **body**.
2. Optionally attach a **credential** from Connections — its `Authorization`
   header is injected server-side. Credential-supplied headers **override** any
   header of the same name you typed, and the real secret never appears in the
   request you author.
3. Send. You get back the status, headers, and body (capped at 5 MB).
4. **History** keeps your past requests for re-running.

## Guardrails

This tool can make the server talk to arbitrary URLs, so it's heavily fenced:

- **SU only**, 30 requests/min/user.
- **SSRF protection** — blocks requests to loopback, private/RFC1918,
  link-local (including the cloud metadata address `169.254.169.254`),
  multicast, and IPv6 ULA ranges. You can't use it to poke internal services.
- **Redirects are not followed automatically** — a 3xx comes back with its
  `Location` so you can re-run deliberately; each re-run passes through the SSRF
  gate again.
- **Credential scope is enforced** — if a credential has an `allowed_urls`
  scope and your URL isn't in it, the request is hard-rejected (not silently
  sent without auth), so you're never confused about why auth "didn't take."
- **Everything is audited** to `admin_audit_log` (`tool='api_tester'`). Request
  and response bodies are stored only if you choose **save full**; `Authorization`,
  `Cookie`, and `x-api-key` headers are always redacted before storage.

## Note

Credentials come from the same store as everything else —
[Integrations → Connections](../04-Integrations/01-connections.md). Add or
authorize a credential there first, then select it here.
