# Contact Roles — the role types a contact can hold

**Where:** More → YisraCase Config → **Contact Roles** tab.
**Who:** changing role types needs the *firm settings* permission (admin, IT,
SU). Everyone else sees the tab read-only — a banner says so, the editing
controls are gone, and **Show fields** still opens a type's fields to read.
**Tables:** `contact_role_types` (the catalog, one row per type) and
`contact_roles` (which contact holds which role, with its attributes).

## What it is

A role says what a contact *is* to the firm's work — a trustee, a judge, a
mediator. The catalog of role types drives:

- the contact form's **Roles** section (which roles can be added, and the
  structured fields each one asks for);
- the Contacts tab's role filter;
- every role consumer in the code — the trustee roster behind trustee
  validation, and judge resolution from a docket's suffix.

Roles are not the free-text **contact type** label, and they are separate from
the person / organisation axis (`contact_kind`).

## The code is permanent

Each type has a **code** (`trustee`, `mediator` — lower-case letters, digits
and `_`, up to 40) and a **label**. The code never changes: every contact that
holds the role points at it, and consumers name it in code. To stop offering a
type, untick **Active** — never rename or delete it.

## Editing a type

Each type is a card with its label, a sort order, **Active**, and **Edit
fields**, which opens its fields. A type's **Save** is on its own card and
saves that type alone; a server refusal shows, word for word, on that card.
**New Role Type** (the top bar, or the button above the list) goes to the
**Add Role Type** card: a code and a label.

### Fields — a role's structured attributes

A field has a **key** (stored on each contact's role row — changing it later
leaves old rows under the old key), a **label**, a **type** — `text`, `url`,
`number`, `select` or `multi_select` — and optionally **Required**, a
**placeholder** and, for the select types, **options**.

**Options keep their type.** Type them comma-separated: a token that looks
like a number is stored as a NUMBER (`7, 11, 12, 13` → the numbers 7, 11, 12
and 13 — the trustee chapter options, which the trustee matcher compares as
numbers), anything else as text. For an option that must stay a string even
though it looks numeric, or that contains a comma, type a JSON array instead
(`["7", "a, b"]`). An option list the comma form cannot show faithfully is
displayed as JSON, so opening a type and saving it never changes an option's
type.

## API

| Route | Does |
|---|---|
| `GET /api/contact-role-types[?include_inactive=true]` | The catalog (any staff) |
| `POST /api/contact-role-types` | Create `{ role_code, label }` — `firm.settings` |
| `PUT /api/contact-role-types/:code` | Update label, sort order, active, `attrs_schema` — `firm.settings` |

The writes are `requireAuth({ audience:'staff', can:'firm.settings',
allowApiKey:true })`. Adding, editing or ending a role ON a contact
(`/api/contacts/:id/roles…`) is record data and stays open to every staff
member.

## Files

| File | What |
|---|---|
| `public/caseconfig/contactRoles.html` | The tab (moved from Settings — one editor per setting) |
| `routes/api.contactRoles.js` | Catalog and per-contact role routes |
| `lib/trusteeRoster.js` | The trustee roster built from `trustee` role rows |
| `tests/contactRolesConfig.test.js` | The tab: option identity, per-type saves, create, read-only |
| `tests/contactRoles.roleForms.test.js` | The contact form's Roles section and the page contracts |
