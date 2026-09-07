# E-Signature

Getting a document signed: building a template with fillable placements,
prefilling it from case data, sending it to one or more signers, tracking what
came back, and filing the executed PDF onto the case.

The provider today is **Zoho Sign** (`services/esign/zohoSignProvider.js`), but
the provider sits behind an adapter — templates, placements, prefills, the send
flow, the webhook ledger and the case widget are all ours.

Signing itself is a [client-facing surface](../06-Client-Facing/) — the signer
follows a link and never logs in — but the bulk of this section is the staff
side: authoring templates and operating the queue.

## Contents

| # | File | What's in it |
|---|------|----|
| 1 | [01-overview.md](01-overview.md) | The four parts of getting something signed, the status lifecycle and what each status means operationally, the layer map, and why the vendor is confined to one directory. |
| 2 | [02-templates.md](02-templates.md) | Contract templates — the two field classes, the placement schema, the literal prefill-resolver whitelist, save-time validation, and why templates are never deleted. |
| 3 | [03-sending-and-filing.md](03-sending-and-filing.md) | The send sequence and the different right answer at each failure point, remind/resend/recall/satisfy, webhooks and the nightly reconciliation, and the Dropbox filing fallback ladder. |
| 4 | [04-api-and-schema.md](04-api-and-schema.md) | Every endpoint and every table, including why the event trail carries two timestamps. |

---

## Related

- **[Documents](../05-Subsystems/06-documents.md)** — where the executed PDF
  lands on the case.
- **[YisraFlow](../03-YisraFlow/)** — `esign_send_from_template`,
  `esign_get_status`, `esign_remind`, `esign_recall` as workflow steps, and the
  nightly `esign_reconcile` job.
- **[Connections](../04-Integrations/01-connections.md)** — the stored provider
  credential.
