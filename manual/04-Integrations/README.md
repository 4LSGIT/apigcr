# 04 — Integrations

External-service integrations: the Connections credential system that powers them, and the native service integrations built on it.

| # | File | What it covers |
|---|---|---|
| 1 | [01-connections.md](01-connections.md) | Connections — the firm-wide credential management system. Concepts, encryption format, OAuth lifecycle, usage recipes. |
| 2 | [02-connections-live-test.md](02-connections-live-test.md) | End-to-end test playbook for Connections. Run once against a real OAuth provider before opening to production traffic. |
| 3 | [03-rc-subscription-bootstrap.md](03-rc-subscription-bootstrap.md) | One-time bootstrap to register RingCentral webhook subscriptions against the three RC hooks. Operator runbook for the "RC Subscription removed" IT alert lives here too. |
| 4 | [04-google-calendar.md](04-google-calendar.md) | Native Google Calendar integration: gcalService, REST API, gcal_* internal functions, credential/calendar selection. |
| 5 | [05-dropbox.md](05-dropbox.md) | Native Dropbox integration: dropboxService, REST API, dropbox_* internal functions, stage-aware case folders, naming-convention templates. |
