# 1 — Overview: which surface does the client get?

## For operators

The firm has six ways of putting something in front of a client. They look
similar from the inside and behave very differently, so the first question is
always *which one is this?*

| The client needs to… | Surface | How they're identified |
|---|---|---|
| Move or cancel an appointment they already have | **Manage link** — `4lsg.com/m/…` | The link *is* the credential |
| Book a new appointment | **Booking page** — `/book/<slug>` | Nobody, or a prefill token |
| Send us documents | **Document request** | The link is the credential |
| See everything about their matter | **Client portal** | PIN login |
| Read a marketing or intake page | **Landing page** | Nobody |
| Sign something | **E-signature envelope** | The envelope link is the credential |
| Fill in a form | **External form** — `/f/<form_key>` | Nobody, or a URL prefill |

### The one distinction that matters

**Only the portal has a login.** Everything else hands the client a link that is
itself the credential — long, unguessable, and scoped to exactly one thing.

That difference decides where you send someone:

- *"I just need them to reschedule."* → manage link. Making a client log in to
  move an appointment is friction with no benefit.
- *"They need to see their case."* → portal. A one-shot link can't carry an
  ongoing relationship.

A link-as-credential is only as private as the message it was sent in, which is
why each one is scoped narrowly — a manage link can touch one appointment, a
document request one upload. None of them can see a case.

### Choosing between them

- **Manage vs booking.** Manage is for an appointment that exists; booking is
  for one that doesn't. A cancellation from a manage link can offer a booking
  page as its next step — that's `manage_fallback_url`.
- **Document request vs portal documents.** A request is one specific ask, sent
  out and answered. The portal's document surface is standing access. Use a
  request to chase something; use the portal for "where's my paperwork."
- **Landing page vs external form.** A landing page is a page that may contain a
  form; an external form is the form itself, hosted on a branded page. If you're
  designing a page, start with the landing page; if you want a form to fill in,
  start with the form.
- **Portal cards vs everything else.** Much of what a client sees inside the
  portal is configurable without a deploy. Before asking for a new client-facing
  feature, check whether a card does it.

### What clients can't reach

Worth knowing so you don't go looking: nothing in
[05-Subsystems](../05-Subsystems/) is client-facing. Video is shared *to*
clients but managed entirely by staff, and redirects produce branded short links
that can point anywhere — including at the surfaces above.

---

## Where each one is documented

| Surface | Chapter |
|---|---|
| Client portal | [02-client-portal.md](02-client-portal.md) |
| Manage links | [03-self-service-links.md](03-self-service-links.md) |
| Booking pages | [04-booking-and-scheduling.md](04-booking-and-scheduling.md) |
| Document requests | [05-document-requests.md](05-document-requests.md) |
| Landing pages | [06-landing-pages.md](06-landing-pages.md) |
| E-signature | [07-ESign](../07-ESign/) |
| External forms | [YisraForms → External forms](../02-YisraForms/15-external-forms.md) |

## Two things that cut across all of them

**Branding.** The portal login, booking pages and landing pages each carry their
own logo and colour settings. They are configured separately and can drift
apart — worth a look together after any rebrand.

**Firm-local time.** Every client-facing surface that shows a date or time works
in firm-local wall time, not the visitor's timezone and not UTC. A client in
another state sees the firm's clock.
