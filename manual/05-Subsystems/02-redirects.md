# Redirects — Overview

The Redirects Manager turns long, ugly links into short, branded ones under our
own domain. Instead of texting a client a 200-character Clio payment URL, you
send them `app.4lsg.com/r/smith-retainer` — shorter, trustworthy, and clickable
on a phone.

## What you can do with it

- **Shorten any link** — pick a slug (the end of the short URL), paste the long
  destination, and you get a clean `app.4lsg.com/r/<slug>` link.
- **Brand the link** — it's on our own domain, so clients see `app.4lsg.com`,
  not a random shortener.
- **Edit the destination later** — the short link stays the same; you can point
  it somewhere new without re-sending anything.
- **Track clicks** — each redirect counts how many times it's been followed.

## Where to find it

**More → Redirects Manager** in the main navigation. Any logged-in user can use it.

---

## Creating a redirect

1. Click **+ New** (or the equivalent add button).
2. **Slug** — the short, memorable end of the URL (e.g. `smith-retainer`). Click
   **Randomize** if you just want a random one. Allowed characters: letters,
   numbers, hyphens, and underscores, up to 64 characters.
3. **Destination URL** — the real link you're shortening (e.g. a Clio payment
   link). Must start with `http://` or `https://`.
4. **Label** — an optional note to yourself so you can find it later (e.g.
   "Smith retainer payment"). Not shown to the client.
5. Click **Save**.
6. Use **Copy** to grab the short link, then paste it into your text or email.

## Sharing the link

The short link is `app.4lsg.com/r/<slug>`. It works the same everywhere — text,
email, printed on a letter, behind a QR code. When a client clicks it, they're
sent straight to the destination; they may briefly see our domain before the
real page loads.

Slugs are **case-insensitive** — `/r/Smith-Retainer` and `/r/smith-retainer` go
to the same place, so you don't have to worry about how a client types it.

## Editing and deleting

- **Edit** — change the destination, label, or turn the redirect off. The short
  link itself stays the same, so a link you already sent keeps working (or stops
  working, if you turn it off).
- **Delete** — removes the redirect entirely. Anyone who clicks the old link
  afterward gets the "link unavailable" page.

---

## A few things to know

### Turned-off or deleted links show a branded page

If a redirect is inactive, deleted, or never existed, the visitor sees a clean
"link unavailable" page with the firm's logo, phone, and email — not a broken
error. So an old or mistyped link still looks professional.

### Slugs must be unique

Two redirects can't share a slug. If you try to reuse one, the system tells you
it's taken. (This is case-insensitive too — `Payment` and `payment` count as
the same slug.)

### Don't put anything secret in the slug

The slug is visible in the URL you hand out. The destination link is only seen
after the click, but the slug and label are for your and the client's
convenience — keep them non-sensitive.
