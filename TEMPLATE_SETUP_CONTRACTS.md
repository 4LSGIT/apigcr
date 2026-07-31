# Contract template setup — Low Money Down fee agreements

Working doc for templateAdmin. Three PDF-type templates. Every template is
authored for TWO signers (signer 1 = Primary debtor, signer 2 = Secondary);
single-filer cases work because sendingform-bk sends with
`drop_unmatched_signers` — signer-2 fields are stripped server-side when only
one recipient is on the envelope. **So: always place the signer-2 fields.**

Common settings on all three:
- template_type: **pdf** (locked after create)
- kind: **contract** ← exact string; sendingform-bk filters on it
- expiration_days: 14 (default)
- reminder_seq_id: **<id printed by ref/2026-07-31_contract_followup_seq.sql>**
- completion_targets: leave empty (signed already files + tasks via webhook)
- Field labels ("Shown to signer") ≤60 chars — Zoho renders them in the box.

Prefill-value note: `case.case_name` resolves to the PRIMARY debtor's name
only. For joint cases, edit the value in the sending form before send
("John Smith and Jane Smith") — the value inputs are right there.

Date blanks: use the Zoho **date** signer field — it auto-stamps at signing.
No resolver, no staff typing. "Made on"/"Signed on" = the signing date, which
is correct for these agreements.

---

## 1. Chapter 13 Fee Agreement (1 page)

Name: `Chapter 13 Fee Agreement`

Field schema (section 3):
| key | label | type | resolver | required | default |
|---|---|---|---|---|---|
| client_name | Client Name(s) | text | case.case_name | yes | |
| amount_prior | Amount due before filing ($) | money | *(none)* | yes | |

Placements:
- p1 "made on ______" → **date**, signer 1
- p1 "and ______ (CLIENT)" → **text**, key `client_name`
- p1 "$______ prior to the filing" → **text**, key `amount_prior` (small box, ~60pt wide)
- p1 installment-payments "Check here…" → **checkbox**, signer 1, label
  "Ask court for filing-fee installments", optional
- p1 "Signed on ______" → **date**, signer 1
- p1 CLIENT signature line 1 → **signature**, signer 1
- p1 CLIENT signature line 2 → **signature**, signer 2

`amount_prior` has no resolver on purpose — it is the per-client variable.
The sending form highlights it red until filled; send hard-fails without it
(ESIGN_MISSING_PREFILL).

---

## 2. Chapter 7 Post-Filing Fee Agreement (6 pages)

Name: `Chapter 7 Post-Filing Fee Agreement`

Field schema:
| key | label | type | resolver | required | default |
|---|---|---|---|---|---|
| client_name | Client Name(s) | text | case.case_name | yes | |
| case_number | Case No. | text | case.case_number_full | yes | |

Placements:
- p1 "made on ______" → **date**, signer 1
- p1 CLIENT blank → **text**, key `client_name`
- p1 "Case No. ______" → **text**, key `case_number`
- p2 payment table "Client chooses: ______" → **dropdown**, signer 1, required,
  label "Payment schedule", options:
  `Weekly — $97 x 24`, `Bi-weekly — $194 x 12`, `Semi-monthly — $194 x 12`, `Monthly — $388 x 6`
- p2 "Date of first payment: ______" → **input_text**, signer 1, required,
  label "Date of first payment (within 14 days of filing)", max_length 40
- p2 method "Client chooses: ______" → **dropdown**, signer 1, required,
  label "Payment method", options: `Cash App`, `Zelle`, `Debit Card`
- p2 "$Cashtag ______" → **input_text**, signer 1, optional, label
  "$Cashtag (if Cash App)", max_length 40
- p2 "Zelle e-mail or telephone ______" → **input_text**, signer 1, optional,
  label "Zelle email/phone (if Zelle)", max_length 60
- p6 Debit Card & Bank Account block — **per SS's pending decision, place as
  signer inputs for now** (all signer 1, all OPTIONAL — the client may be
  paying by Cash App/Zelle):
  - Name on card/account → input_text, max 60
  - Debit card no. → input_text, max 20
  - Expires (MM/YY) → input_text, max 8
  - CVV → input_text, max 4
  - Billing street → input_text, max 80
  - City → input_text, max 40; State → input_text, max 4; Zip → input_text, max 10
  - Bank name → input_text, max 60
  - Checking / Savings → two **checkbox** fields (labels "Checking", "Savings")
  - Account number → input_text, max 20; Routing number → input_text, max 12
  ⚠ Flagged to SS: CVV storage is prohibited under PCI DSS; the signed PDF
  lands in Dropbox + Zoho's cloud. Easy to delete these fields later.
- p6 "Signed on ______" → **date**, signer 1
- p6 CLIENT signature line 1 → **signature**, signer 1
- p6 CLIENT signature line 2 → **signature**, signer 2

---

## 3. Chapter 7 Pre-Filing Fee Agreement (6 pages)

Name: `Chapter 7 Pre-Filing Fee Agreement`

Field schema:
| key | label | type | resolver | required | default |
|---|---|---|---|---|---|
| client_name | Client Name(s) | text | case.case_name | yes | |

Placements:
- p1 "made on ______" → **date**, signer 1
- p1 CLIENT blank → **text**, key `client_name`
- p2 Option #1 / Option #2 big boxes → **radio** group, signer 1, required.
  Group name: `Payment Option` (this is what the signer sees). Two boxes:
  - box on Option #1 → value `Option 1 - Pay Before You File ($2,490 + $338)`
  - box on Option #2 → value `Option 2 - Low Money Down ($500 now)`
- p2 Option #1 "Check here if unable to pay the $338 filing fee…" →
  **checkbox**, signer 1, optional, label "Opt 1: filing fee in installments"
- p2 Option #2 same checkbox → **checkbox**, signer 1, optional, label
  "Opt 2: filing fee in installments"
- p6 "Signed on ______" → **date**, signer 1
- p6 CLIENT signature line 1 → **signature**, signer 1
- p6 CLIENT signature line 2 → **signature**, signer 2

⚠ Source-doc typo for SS: p3 payment table header reads "8 Month / 32 Week
Payment Plan" over 24-week numbers. Fix the PDF and re-upload to the template
whenever; placements survive a PDF re-upload only if geometry is unchanged —
same-layout fix is fine.

---

## After setup — smoke (test mode is still ON, so no credits burn)

1. Preview each template against a real case → fills land in the blanks.
2. From a test case's Sending Form: check Contracts → pick one → values load →
   Send. Confirm: envelope arrives, `reminders_enrolled` event shows the
   Contract Follow-up sequence, dropdown/radio/checkbox render on the Zoho
   signing page.
3. Single-filer case + a joint-placed template → send succeeds (signer-2 fields
   stripped), signing page shows only signer-1 fields.
4. Sign it → `reminders_cancelled`, task never fires, signed ZIP files to
   Dropbox.
5. Before REAL clients: buy Zoho credits, set esign_credit_balance, flip
   esign_test_mode to '0'.
