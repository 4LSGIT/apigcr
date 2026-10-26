# Casey north star

This file states the destination. `ref/ASK_CASEY_ACTIONS_PLAN.md` holds the
mechanics and the ladder; where a planning decision is about *whether* Casey
should be able to do something, this file governs. Fred's words, 2026-10-26.

## The idea

Casey reads and acts **with the user's access level and explicit permission**:
the user clicks a button to execute a pre-made action (assembled via discovery
steps), using the user's own access, as if it was the user. That boundary —
typed proposal, exact review, the user's click, the canonical route — is the
security model, and it is what makes the rest of this file safe to want.

## The destination

A really powerful AI connection that can do **(almost) whatever the user can
do**, and helps the user navigate YisraCase **without needing to understand
the technical parts**. The spectrum, in Fred's terms:

- **Page awareness** — Casey knows what the user is looking at (shipped: P13
  workspace context).
- **The whole product** — Casey works across the spectrum of YisraCase, not a
  curated corner of it.
- **Automations** — building, editing, debugging, and *explaining* workflows,
  sequences, trigger rules, hooks, and ingest rules. This is the strategic
  core — "90% of the reason to have an AI integration" (ruling, 2026-10-22):
  non-dev users get template-driven automation through Casey.
- **Data synthesis** — compiling data from across sources (records, comms,
  documents, reports) and presenting it coherently. An investigation that
  stops on a budget is a defect against this goal, not a safety feature:
  Casey must at least be able to ask the user for more turns (ruling,
  2026-10-26 — shipped as plan slice R1, the Keep going control).
- **YCv3** — helping set up, explain, and edit the config-based system YCv2 is
  moving toward. Constraint on YCv3 design itself: config formats are chosen
  to be Casey-authorable.
- **Content building** — landing pages and emails built from the asset
  library (or user-given links).
- **YisraForms** — building complex integrated forms with live data load and
  save, not just drafts and prefills.
- **Sends are in scope** — Casey sends SMS and email through reviewed cards
  (ruling 15, 2026-10-27): "casey actions are all read and approved by a
  user" is the permission model; there is no standing category of
  user-capable actions Casey may never propose, only actions not yet built
  or needing a product/threat-model decision first.

## The standing default (Fred, 2026-10-26)

**The burden of proof sits on excluding a capability, not on enabling it.**
When a manager or reviewer proposes a default, it is framed as: *the vision
says yes; the risk is X; the recommended mitigation is Y* — never as a quiet
exclusion. Conservative drift is the recurring failure mode of this arc
(automation authoring deprioritized 2026-10-21, external sends excluded until
ruling 15, the read budget hard-capped); each took a Fred ruling to undo.
Exclusions that survive are the ones Fred ruled on, recorded in the plan doc.

## Named so they exist

These vision items previously had no written home. They are future families /
slices to be planned, not commitments to an order:

- **Pages & email building** from the asset library (new A-family; relates to
  `pages`/`pageService` and the YCv3 multi-site plan).
- **A12 YisraForms, full-depth** — the current A12 paragraph (draft/prefill)
  is the first rung, not the scope: template building, live load/save
  integration, publishing.
- **Read-loop continuation** — when an investigation stops on budget, the
  user can grant more turns (minimum bar, per Fred); a true "keep going"
  continuation is the full shape. Shipped in full as plan slice R1.
- **YCv3 config copilot** — carried as a design constraint into YCv3
  planning, so configs are born Casey-authorable.
