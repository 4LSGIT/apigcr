# YisraVideo — Overview

YisraVideo is the firm's home-grown video sharing system. It replaces our Dubb subscription with a tighter integration into YisraCase: you upload a video once, share it through any channel (email, SMS, MMS, posted link, QR code), and YisraCase tracks who watched what — automatically attached to the right contact and case.

## What you can do with it

- **Upload videos** — MP4 video, optional poster image, optional GIF preview. Each video gets a public landing page with a player, action buttons, and a row of related videos.
- **Share through any channel** — copy the link straight, send via the campaign manager, drop into a one-off email through the contact's Communication tab, or paste into an external email/text. The link works the same everywhere.
- **Track engagement** — page views, plays, completion percentage, and clicks on each action button — broken down by contact when available.
- **Action buttons on videos** — each video can have a row of buttons (e.g. "Book My 341 Prep Call", "Upload Documents") that send the viewer wherever you want, with the contact's identity carried through.

## Where to find it

**More → Video Manager** in the main navigation. Any logged-in user can use it.

The Video Manager has two panes:

- **Left:** list of all videos. Click a video to edit it.
- **Right:** the editor for the selected video, with analytics at the top.

A "+ New Video" button in the top of the list pane creates a new video. A refresh button next to it reloads the list.

---

## Adding a new video

1. Click **+ New Video**.
2. Fill in **Title** (required) and an optional **Description** (this is what shows on the public landing page; you can use newlines for paragraphs).
3. Upload the **video file** — MP4 only, up to 500 MB. The system reads the video duration automatically. Large files take a minute or two — there's a progress bar.
4. Optional: upload a **Poster** image. JPGs work best. The poster shows before the user presses play, and is what appears in email previews and link previews on phones.
5. Optional: upload a **GIF** preview. Used in email and MMS as a more eye-catching alternative to the still poster. Outlook freezes GIFs to the first frame, so the poster is still the safer default for emails.
6. Add **Tags** — comma-separated. Tags drive related-video matching (see below).
7. Pick an **Access Level**:
   - **Public** (default) — anyone with the URL can watch it.
   - **Contact-only** — the URL only works when it carries a `?c=<contact_id>` parameter pointing to a real contact. Without it, the page returns 404. Useful for testimonials or gated content.
8. Add **Action Buttons** — the row of clickable buttons that appears below the video on the landing page. For each button:
   - **Label** — what the button says ("Book My 341 Prep Call")
   - **URL** — where it goes. Use `{{c}}` anywhere in the URL to insert the viewer's contact ID — e.g. `https://app.4lsg.com/book?c={{c}}`. When an anonymous viewer (no contact) opens the page, `{{c}}` becomes empty.
   - **Style** — Primary (filled), Secondary (outlined), or Ghost (text-only)
   - The ↑ ↓ buttons reorder them; ✕ removes one.
9. **Related Videos** — pick up to 3 videos that should appear at the bottom of this video's landing page. The picker searches your published videos. If you pick fewer than 3, the system fills the rest by matching tags.
10. **Publish** — leave the "Published" checkbox unchecked to save as a draft. Drafts have a slug but `/v/<slug>` returns 404 until you publish. The system will warn you on save if you're saving a new video as a draft.
11. Click **Save**.

After saving, the editor automatically scrolls to the analytics section so you can see the page in its "live" state.

## URL slugs

Every video has a **slug** — the human-readable end of its URL (`/v/<slug>`). The system generates one automatically from the title (e.g. "What to expect at your 341" becomes `what-to-expect-at-your-341-a3f7`).

You can rewrite a slug at any time. The old slug becomes an **alias** — anyone who clicks an old shared link still lands on the right video. The list of past aliases shows below the slug field on edit. There's no limit; rename freely.

## Sharing a video

There are three buttons on each video in the list:

- **Copy landing URL** — `/v/<slug>` with no parameters. Use for posting publicly, QR codes, or anywhere you don't have a specific contact in mind.
- **Copy URL for contact…** — opens a contact picker, then copies a URL with `?c=<contact_id>` appended. The action buttons on the page will then know who's watching.
- **Copy embed snippet** — produces a clickable HTML block (poster image wrapped in a link to the landing page). When you have both a poster and a GIF, you'll see two snippets — one of each. The contact placeholder in the snippet is `{{contacts.contact_id}}`, which the campaign manager fills in automatically when sending; for one-off emails just paste it through Insert Video instead.

### Insert Video buttons in the message editors

For high-frequency sending, use the **Insert Video** button found in:

- The **Communication tab** on a contact (SMS panel and Email panel)
- The **Sending Form** on a case (Other section, both SMS and Email modes)
- The **Compose** tab in the Campaign Manager (works for both SMS and email campaigns)

Click Insert Video, search and select the video, then choose the format:

- **Email contexts** — "Insert as poster + link" or "Insert as GIF + link" or "Insert text-only link". Inserts a clickable embed at your cursor position.
- **SMS with non-RingCentral sender** — inserts the URL as plain text at the cursor.
- **SMS with RingCentral sender (MMS-capable)** — three options: plain SMS, MMS with poster, MMS with GIF. The MMS options write the URL to the SMS body AND attach the image to the message in one click.

Insertion in single-contact contexts (Communication, Sending Form) substitutes the real contact ID into the URL right away — what you see in the editor is what you'll send. In the Campaign Manager, the URL contains a placeholder that gets filled in per recipient at send time.

---

## Analytics

The Analytics panel on each video shows:

- **Total views** — every time someone opens the landing page, broken down into "identified" (a contact ID was on the URL) vs "anonymous" (no contact ID).
- **Played** — how many of those viewers actually pressed play, with the percentage.
- **Completed** — how many watched to the end (100% completion), with the percentage of plays.
- **Avg watch** — the average completion percentage across all views.
- **CTA clicks** — a list of action button clicks, by label, with counts.

Views are recorded the moment the page opens, even before play. The contact ID and (when available) the contact's most recent open primary case are attached to each view in the database.

### Resetting analytics

The **Reset Analytics** button (in the analytics panel, only visible after you have views) zeros out the visible counters and stamps a "Stats since" timestamp on the video. Past view records are preserved in the database — they just stop counting toward the displayed stats.

Use it when:

- You're done dev-testing a video and want a clean slate before sending it to clients.
- You re-uploaded a corrected version and want the new version's stats from scratch.
- You need a known starting point for a demo.

The reset can only be undone with direct database access. The confirmation prompt makes you confirm before it runs.

---

## A few things to know

### Drafts return 404

If a video isn't published, `/v/<slug>` returns 404 even though the video exists in the manager. Publish before sharing.

### Unsaved changes are protected

If you start editing a video and then click **+ New Video** or another row in the list, the system asks before discarding your edits. Click Save first, or click Discard if you don't want them.

### The landing page works everywhere

The link previews properly on iMessage, Slack, WhatsApp, and Outlook. The page loads on mobile, on desktop, with or without a contact ID. There's nothing special about the Insert Video button — it just produces a snippet that uses the same public URL anyone could reach.

### View tracking is per-page-open

If a contact opens the same video twice, that's two views. If they open it once, play it three times during that session, that's still one view (the play and progress events update the same view row).

### Anonymous viewing is supported by design

Sharing a public-access video without a `?c=` parameter is fine and counts as an anonymous view. Contact-only videos require a valid contact ID to render.