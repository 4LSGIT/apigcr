# Part 10 — Hosting & Wiring

Forms are standalone HTML pages loaded inside iframes. This section covers how to connect a form to its parent page.

---

## The apiSend Relay

Forms call `window.parent.apiSend()` for all API requests. This works through a relay chain:

```
index.html          ← apiSend() defined here
  └─ case.html      ← window.apiSend = P.apiSend   (relay)
       └─ forms/341notes.html   ← calls P.apiSend()
```

**Rule: any page that hosts a form iframe must relay apiSend.**

```js
const P = window.parent;
window.apiSend = P.apiSend;
```

This works at any nesting depth. A form always looks exactly one level up.

---

## Loading a Form

The parent sets the iframe `src` with the entity ID as a query parameter:

```js
// Contact form:
E("tabInfoIframe").src = `forms/contact.html?contact_id=${clientID}`;

// 341 notes:
E("341iframe").src = `forms/341notes.html?case_id=${caseId}`;
```

The form fetches its own data — no URL query strings with field values needed.

### Before (old pattern)

```js
// 20+ fields concatenated into a URL:
E("tabInfoIframe").src = `contactform.html?firstname=${data.contact_fname}&middlename=${data.contact_mname||""}&lastname=${data.contact_lname}&phone=${data.contact_phone||""}&email=...`;
```

### After

```js
E("tabInfoIframe").src = `forms/contact.html?contact_id=${clientID}`;
```

---

## Listening for Save Events

When a form saves, it sends a `postMessage` to the parent. Listen for this to refresh data:

```js
window.addEventListener('message', async (e) => {
  if (e.data?.type === 'form-saved' && e.data.form === 'contact_info') {
    try {
      const refreshed = await P.apiSend(`/api/contacts/${clientID}`, 'GET');
      clientData = refreshed.contact;
      E('fname').innerHTML = clientData.contact_fname || "";
      E('lname').innerHTML = clientData.contact_lname || "";
      E('phone').innerHTML = clientData.contact_phone
        ? clientData.contact_phone.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3') : "";
    } catch (err) {
      console.warn('Refresh after save failed:', err);
    }
  }
});
```

### Message Shape

```js
{ type: 'form-saved', form: 'contact_info', linkType: 'contact', linkId: '1001' }
```

Sent automatically by `yc-forms.js`. Skipped in external mode.

---

## Same Form, Multiple Parents

The same form can be hosted in different pages:

| Form | Parent | URL param |
|------|--------|-----------|
| `forms/contact.html` | `contact2.html` | `?contact_id=${clientID}` |
| `forms/contact.html` | `contact.html` (legacy) | `?contact_id=${clientID}` |
| `forms/341notes.html` | `case.html` | `?case_id=${caseId}` |

The form doesn't know or care who its parent is — it just needs `P.apiSend()` to exist.

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
2. Ensure `window.apiSend = P.apiSend` in the parent page
3. Set iframe `src` to `forms/yourform.html?entity_id=${id}`
4. Add `message` listener if parent should react to saves
5. Test the full loop
