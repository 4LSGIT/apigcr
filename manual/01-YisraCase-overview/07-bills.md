# Bills

> **This section is a placeholder. Billing functionality is planned for a future release.**

---

## Overview

Bills will track what clients owe and what they have paid. Each bill will be linked to a contact and optionally to a case.

---

## Planned Features

- Invoice creation linked to a contact and/or case
- Payment recording (partial and full)
- Outstanding balance tracking
- Payment plan support
- Integration with tasks and the activity log (e.g., automatic task creation when a payment is overdue)
- Bill status tracking (Unpaid, Partial, Paid, Overdue, Waived)

---

## Current State

The `task_link_type` field already supports `'bill'` as a valid link target, and the data model is designed to accommodate billing records. The billing module itself has not yet been built.

When billing is implemented, this section will be updated with full documentation covering how to create invoices, record payments, run reports, and configure automated payment reminders.

---

*Last updated: initial stub — no billing features are live.*
