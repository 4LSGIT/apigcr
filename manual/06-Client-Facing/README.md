# Client-Facing Surfaces

Everything a **client** touches directly. Staff tools live in
[05-Subsystems](../05-Subsystems/); this section is the other side of the glass.

Each surface answers a different question, and they are deliberately separate —
a client who only needs to move one appointment should never have to log in:

| The client needs to… | Surface | Login? |
|---|---|---|
| Move or cancel one appointment | manage link (`4lsg.com/m/…`) | no — the link is the credential |
| Book a new appointment | booking page (`/book/<slug>`) | no |
| Send us documents | document request | no |
| See everything on their case | client portal | yes — PIN |
| Read a marketing / intake page | landing page | no |
| Sign something | [e-signature](../07-ESign/) | no — the envelope link is the credential |

## Contents

| # | File | What it is |
|---|------|----|
| 1 | [01-overview.md](01-overview.md) | Which surface a client should get, how each one identifies them, and the choices between them (manage vs booking, document request vs portal, landing page vs form). |
| 2 | [02-client-portal.md](02-client-portal.md) | The client portal — PIN login and why it never says whether an address matched, the Access tab, the configurable card engine and its whitelist, settings and tables. |
| 3 | [03-self-service-links.md](03-self-service-links.md) | Client manage links (`4lsg.com/m/…`) — the self-service cancel/reschedule page, the `manage_allow_*` policy toggles that control it, and worked examples for every setting. |
| 4 | [04-booking-and-scheduling.md](04-booking-and-scheduling.md) | Public booking pages (`/book/<slug>`), the availability engine and its five busy sources, provider modes, the anti-abuse defences and the double-booking lock. |
| 5 | [05-document-requests.md](05-document-requests.md) | Asking a client for documents and receiving them back — no attachments, no logins, nothing landing on our servers. |
| 6 | [06-landing-pages.md](06-landing-pages.md) | Hosted marketing/intake pages, optionally on a custom domain, with form submissions wired into a YisraHook. (More → Landing Pages) |

---

## Related

- **[External forms](../02-YisraForms/15-external-forms.md)** — public forms at
  `/f/:form_key`, including the branded host page. The form framework itself is
  [YisraForms](../02-YisraForms/).
- **[YisraVideo](../05-Subsystems/01-YisraVideo.md)** — videos are shared *to*
  clients but managed entirely by staff, so the chapter sits with the staff tools.
- **[Appointments](../01-YisraCase-overview/04-appointments.md)** — what the firm
  sees when a client books or reschedules.
