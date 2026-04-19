# Part 10 — Hosting & Wiring

Forms are standalone HTML pages loaded inside iframes. This section covers how to connect a form to its parent page.

---

## The apiSend Relay

Forms call `window.parent.apiSend()` for all API requests. This works through a relay chain:

```
a.html              ← apiSend() defined here
  └─ case2.html     ← window.apiSend = P.apiSend   (relay)
       └─ forms/341notes.html   ← calls P.apiSend()
```

**Rule: any page that hosts a form iframe must relay apiSend.**

```js
const P = window.parent;
window.apiSend = P.apiSend;
```

This works at any nesting depth. A form always looks exactly one level up.

---

## Firm Data Relay

The shell (`a.html`) loads firm-wide data once after auth — phone lines, email senders, active users, current user — into `window.firmData`. Any form that needs this data reads it from the parent:

```js
// In the shell (a.html): loaded once
window.firmData = { phoneLines, emailFrom, currentUser, users };

// In case2.html / contact2.html: relay
window.firmData = P.firmData;

// In the form: read
const firmData = P.firmData || {};
```

Forms do **not** make their own calls to `/api/phone-lines`, `/api/email-from`, or `/api/users/me`. That data is already in `firmData`.

---

## The waitForParent Boot Pattern

Iframes that load before the parent's `apiSend` or `firmData` is defined need to wait. Use this boot loop at the bottom of the form's script:

```js
(function waitForParent() {
  if (P.apiSend && P.firmData?.phoneLines) return init();
  setTimeout(waitForParent, 100);
})();
```

**When to use it:**
- Any iframe whose `src` is set during parent initialization (before the parent finishes its own boot)
- Any iframe that reads from `P.firmData` or `P.entityData` during init
- Most forms hosted in `case2.html` and `contact2.html` need this

**When to skip it:**
- Admin iframes lazy-loaded on-demand (e.g. `automationManager.html`, `featureRequests.html`) — by the time the user clicks to open them, the parent has finished booting
- Simple forms that only use `P.apiSend` and don't touch `firmData` or `entityData` — `apiSend` is relayed before any iframe `src` is set

Forms that use this pattern today: `communicate.html`, `campaign.html`, `sendingform.html`. For standard YCForm-based forms hosted in `case2.html` / `contact2.html`, `yc-forms.js` handles waiting internally by checking `window.parent.entityData` before falling back to an API call — you don't need the boot loop unless your form's init does additional work before calling `form.init()`.

---

## Loading a Form

The parent sets the iframe `src` with the entity ID as a query parameter:

```js
// Contact form:
E("tabInfoIframe").src = `forms/contact-form.html?contact_id=${clientID}`;

// 341 notes:
E("341iframe").src = `forms/341notes.html?case_id=${caseId}`;
```

The form fetches its own data — no URL query strings with field values needed.

### Before (old JotForm pattern, for historical context)

```js
// 20+ fields concatenated into a URL:
E("tabInfoIframe").src = `contactform.html?firstname=${data.contact_fname}&middlename=${data.contact_mname||""}&lastname=${data.contact_lname}&phone=${data.contact_phone||""}&email=...`;
```

### After (YisraForms)

```js
E("tabInfoIframe").src = `forms/contact-form.html?contact_id=${clientID}`;
```

---

## Parent-as-Data-Source

Parent pages (`case2.html`, `contact2.html`) fetch entity data once and expose it on `window.entityData`:

```js
// case2.html
window.entityData = { case, clients, appts, tasks, log };

// contact2.html
window.entityData = { contact, cases, appts, tasks, log, sequences };
```

When a form initializes, `yc-forms.js` first checks `window.parent.entityData[endpoints.load.path]` — if present, it uses that data without making an API call. The form's existing `endpoints.load.path` doubles as the lookup key. No new config needed.

**Fallback.** If `entityData` is missing or doesn't have the requested key, `yc-forms.js` falls back to calling the API directly. External-mode forms always use the API path.

---

## The Save → Refresh → Push Flow

When a form saves, the parent re-fetches and pushes fresh data into all sibling forms:

```
1. Form saves
2. yc-forms.js sends postMessage({ type: 'form-saved', form, linkType, linkId }) to parent
3. Parent's centralized message listener calls refreshEntityData(formKey)
4. refreshEntityData:
    a. Re-fetches entity via API → updates window.entityData
    b. Updates parent's own header / tables
    c. Scans ALL child iframes via document.querySelectorAll('iframe')
    d. For each iframe with a ycForm instance:
         - If dirty → skip (preserve user's unsaved edits)
         - If not dirty → push fresh data, call populate(), re-run onLoad()
       Wrap in try/catch — cross-origin iframes (Dropbox embeds, etc.) throw
       SecurityError on .contentWindow access; handle silently.
```

Both `case2.html` and `contact2.html` implement this listener already. Forms don't need to set up their own — just save normally and the parent takes care of sibling refresh.

---

## Listening for Save Events — Custom Parent Logic

Most parent pages don't need their own listener — `case2.html` / `contact2.html` already handle `form-saved` centrally. If you're building a custom parent that hosts forms, listen like this:

```js
window.addEventListener('message', async (e) => {
  if (e.data?.type === 'form-saved' && e.data.form === 'contact_info') {
    // refresh parent data
  }
});
```

### Message Shape

```js
{ type: 'form-saved', form: 'contact_info', linkType: 'contact', linkId: '1001' }
```

Sent automatically by `yc-forms.js` at the end of every successful save (non-external mode only).

---

## Same Form, Multiple Parents

The same form can be hosted in different pages:

| Form | Host page | URL param |
|------|-----------|-----------|
| `forms/contact-form.html` | `contact2.html` | `?contact_id=${clientID}` |
| `forms/341notes.html` | `case2.html` | `?case_id=${caseId}` |
| `forms/casedetails.html` | `case2.html` | `?case_id=${caseId}` |
| `forms/issn.html` | `case2.html` | `?case_id=${caseId}` |

The form doesn't know or care who its parent is — it just needs `P.apiSend()` to exist (and optionally `P.firmData` / `P.entityData`).

---

## External Forms (Future)

When `external: true`, the form uses `fetch()` directly. No parent iframe, no postMessage. Three auth tiers planned:

| Tier | Auth | Use case |
|------|------|----------|
| Internal | JWT via iframe relay | Staff forms |
| External public | None | Simple intake forms |
| External portal | Token / magic link | Client portal (future) |

---

## Wiring Checklist

1. Create the form file in `public/forms/`
2. Ensure the parent relays both `apiSend` and `firmData`:
   ```js
   window.apiSend  = P.apiSend;
   window.firmData = P.firmData;
   ```
3. Set iframe `src` to `forms/yourform.html?entity_id=${id}`
4. If the form reads from `P.firmData` or `P.entityData` before calling `form.init()`, wrap init in the `waitForParent` boot pattern
5. If hosted somewhere other than `case2.html` / `contact2.html`, add a `message` listener for `form-saved`
6. Test the full loop — save, verify parent data refresh, verify sibling iframes see the change