# Landing Pages — Overview

Landing Pages lets the firm host its own marketing/intake pages — a Chapter 7
offer page, a "free consultation" sign-up, a docs-upload prompt — on our own
infrastructure, optionally on a custom domain. When someone fills out the form
on the page, the submission flows straight into our automation (a YisraHook),
so a new lead can create a contact, fire a text, or anything else a hook can do.

## What you can do with it

- **Host a page** — paste in the page's HTML and publish it. It goes live at
  `app.4lsg.com/p/<slug>`.
- **Use a custom domain** — point a marketing domain (e.g.
  `offers.720debtfree.com`) at a page so the URL has no `/p/` in it.
- **Capture form submissions** — a form on the page sends its fields into a
  YisraHook, which you wire up to do whatever you need (create the contact, text
  the office, etc.).
- **Send people to a thank-you page** after they submit.

## Where to find it

**More → Landing Pages** in the main navigation. Any logged-in user can use it.

---

## Creating a page

1. Click **New Page**.
2. **Slug** — the end of the URL (e.g. `ch7-offer`). Lowercase letters,
   numbers, and hyphens. The page will live at `/p/<slug>`.
3. **Status** — **Draft** while you're building it (a draft URL returns "not
   found" to the public), **Live** when it's ready to share.
4. **Host** *(optional)* — a custom domain you've mapped to us (e.g.
   `offers.720debtfree.com`). Leave blank to just use `app.4lsg.com/p/<slug>`.
5. **Path** *(optional, custom-domain only)* — where on that domain the page
   sits. Blank = the domain root; `/ch7` = `offers.720debtfree.com/ch7`.
6. **Thank-you** *(optional)* — where to send visitors after they submit the
   form. Can be a full URL or another page slug.
7. **Hook** — the YisraHook that receives form submissions (see below).
8. **Page HTML** — the full HTML of the page (`<!DOCTYPE html> …`). Use
   **Preview** to see it before saving.
9. Click **Save**. Use **Copy URL** to grab the public link.

## Wiring up the form (the Hook)

A landing page sends its form submissions to a **YisraHook**, which is where you
decide what happens with a new lead.

- The fastest way: on a saved page, click **Create hook for this page**. This
  builds a starter hook (named `lp-<your-slug>`) already pointed at this page,
  with spam filtering on. It has **no actions yet** — open it under
  **Automation → Hooks** and add the targets (create a contact, send a text,
  notify the office, etc.).
- Every form field on your page arrives at the hook by its field name (a
  `name="website"` field arrives as `website`). The system also adds a few
  details automatically: which page it came from, the visitor's IP, the
  referring URL, and their browser.

> Heads up: a landing-page form delivers its fields in a slightly different
> shape than a hook called directly over the web. Don't point a single hook at
> both a landing page **and** direct webhook calls — give each its own.

## Going live on a custom domain

To use a domain like `offers.720debtfree.com`, the domain has to be pointed at
us first (a one-time DNS/proxy setup — ask IT). Once it's mapped, set that
domain in the page's **Host** field and the page answers at the domain root (or
the **Path** you set). Until the domain is mapped, the `app.4lsg.com/p/<slug>`
URL always works.

---

## A few things to know

### Drafts return "not found"

A page that isn't **Live** returns a 404 to the public, even though it's in the
manager. Flip it to Live before sharing.

### Built-in spam protection

Each page has a hidden honeypot field and a per-visitor rate limit. Obvious bot
submissions are dropped silently — the bot still sees a normal "thanks" so it
doesn't know it was caught. Real submissions go through to your hook.

### Submitting always lands on the thank-you page

After someone submits the form, they're always sent to your thank-you target —
they never see an error page, even if something downstream hiccups. The form
hand-off is fire-and-forget by design.

### Custom domains can take a moment to recognize a new page

When you publish or change a page on a custom domain, it can take up to a minute
for every server to pick up the change. The `app.4lsg.com/p/<slug>` URL is
always immediate.
