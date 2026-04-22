# Files

> See [review.md](review.md) for the full audit (blocker, security cleanup, classifications, migration order).
>
> Status values:
> - `V2` — JWT/API-key auth; fits V2. Inline `db.query` is fine (services only exist where logic is reused)
> - `V2-ok` — V2 in practice, inventory just caught up
> - `needs-migration` — still used V1 code, no V2 replacement yet
> - `legacy-keep` — standalone tool or tied to a live integration; can't delete
> - `legacy-remove` — only referenced from index.html / V1 pages; delete at cutover
> - `standalone` — served by `GET /:page`, independent of V1 or V2 (marketing page, JotForm embed, one-off tool)
> - `safe` — dev/test utility
> - `unknown` — defined but no callers found; verify before acting

## scripts (3)

| File                                | Status           | Note |
| ----------------------------------- | ---------------- | ---- |
| scripts/backfill-password-hashes.js | safe             | one-shot migration, done |
| scripts/backfillAppts.js            | safe             | one-shot, done |
| scripts/backfillCampaignContacts.js | safe             | one-shot, done |

---

## lib (10)

| File                       | Status     | Note |
| -------------------------- | ---------- | ---- |
| lib/auth.jwtOrApiKey.js    | V2         | |
| lib/auth.superuser.js      | V2         | |
| lib/credentialInjection.js | V2         | |
| lib/internal_functions.js  | V2         | |
| lib/job_executor.js        | V2         | |
| lib/logMeta.js             | unknown    | no callers found — verify or delete |
| lib/parseName.js           | V2-ok      | used by routes/api.intake.js:34 |
| lib/sequenceEngine.js      | V2         | |
| lib/unplacehold.js         | legacy-keep| dies with routes/unplacehold.js (B4) |
| lib/workflow_engine.js     | V2         | |

---

## services (22)

| File                           | Status      | Note |
| ------------------------------ | ----------- | ---- |
| services/apptService.js        | V2          | |
| services/calendarService.js    | V2          | |
| services/campaignService.js    | V2          | |
| services/caseService.js        | V2          | |
| services/contactService.js     | V2          | |
| services/dropboxService.js     | legacy-keep | clean service; its *route* is the problem (B5) |
| services/emailService.js       | V2          | |
| services/formService.js        | V2          | |
| services/hookFilter.js         | V2          | |
| services/hookMapper.js         | V2          | |
| services/hookService.js        | V2          | |
| services/hookTransforms.js     | V2          | |
| services/logService.js         | V2          | |
| services/pabblyService.js      | V2          | |
| services/quoService.js         | V2          | |
| services/resolverService.js    | V2-ok       | powers POST /resolve |
| services/ringcentralService.js | V2-ok       | used by smsService + campaignService |
| services/searchService.js      | V2          | |
| services/settingsService.js    | V2          | used by apptService.js:14, taskService.js:27 |
| services/smsService.js         | V2          | |
| services/taskService.js        | V2          | |
| services/timezoneService.js    | V2          | |

---

## public (42)

| File                                 | Status        | Note |
| ------------------------------------ | ------------- | ---- |
| public/a.html                        | V2            | V2 entry point |
| public/appt.html                     | legacy-remove | served at /appt via routes/pages.js; V1-era embed |
| public/apptform.html                 | legacy-remove | only loaded by index.html (V1) |
| public/apptform2.html                | V2            | |
| public/automation/hooks.html         | V2            | |
| public/automation/scheduledJobs.html | V2            | |
| public/automation/sequences.html     | V2            | |
| public/automation/workflows.html     | V2            | |
| public/automationManager.html        | V2            | |
| public/calendar.html                 | V2-ok         | FullCalendar iframe, uses parent.apiSend('/api/events') |
| public/caltest.html                  | standalone    | Michigan Tax Prep marketing/offer page |
| public/campaign.html                 | V2            | |
| public/case.html                     | legacy-remove | replaced by case2.html |
| public/case2.html                    | V2            | |
| public/caseerror.html                | standalone    | case-error display page |
| public/communicate.html              | V2            | |
| public/contact.html                  | legacy-remove | replaced by contact2.html |
| public/contact2.html                 | V2            | |
| public/contactform.html              | legacy-remove | only loaded by contact.html and index.html (V1) |
| public/css/yc-forms.css              | V2            | stylesheet for V2 forms (add to inventory) |
| public/dbConsole.html                | V2            | |
| public/docReq.html                   | V2            | |
| public/docs.html                     | standalone    | served at /docs via routes/pages.js |
| public/featureRequests.html          | V2            | |
| public/feedback.html                 | standalone    | JotForm client-satisfaction iframe |
| public/forms/341notes.html           | V2            | |
| public/forms/casedetails.html        | V2            | |
| public/forms/contact-form.html       | V2            | |
| public/forms/issn.html               | V2            | |
| public/index.html                    | legacy-remove | V1 entry — the file being retired |
| public/js/yc-forms.js                | V2-ok         | |
| public/manuals.html                  | V2            | |
| public/mms.html                      | standalone    | RingCentral MMS sender tool — verify no baked-in secrets |
| public/rating.html                   | standalone    | IT-call rating form (external link) — verify submit endpoint |
| public/reset-password.html           | V2            | |
| public/scripts.js                    | legacy-keep   | shared helpers, loaded by BOTH index.html and a.html |
| public/send-sms.html                 | standalone    | RingCentral SMS sender — calls /ringcentral/send-sms; verify auth pattern |
| public/sendingform.html              | V2            | |
| public/styleOpts.html                | standalone    | 2.7 MB design-system exploration — verify still needed |
| public/survey.html                   | standalone    | JotForm client-satisfaction iframe (same form as feedback.html) |
| public/tabLeads.html                 | V2            | |
| public/uploader.html                 | standalone    | file upload tool — verify submit endpoint |

---

## startup (2)

| File            | Status | Note |
| --------------- | ------ | ---- |
| startup/db.js   | V2     | |
| startup/init.js | V2     | |

---

## tests (2)

| File                     | Status | Note |
| ------------------------ | ------ | ---- |
| tests/test-cron.js       | safe   | ad-hoc script, not a real suite |
| tests/test_classifier.js | safe   | ad-hoc script |

----

## routes (49)

| File                          | Status          | Note |
| ----------------------------- | --------------- | ---- |
| routes/admin.dbConsole.js     | V2              | raw DB is the literal purpose; gated by superuserOnly |
| routes/alert-test.js          | safe            | |
| routes/api.appts.js           | V2              | |
| routes/api.cases.js           | V2              | |
| routes/api.checklists.js      | V2              | |
| routes/api.contacts.js        | V2              | |
| routes/api.featureRequests.js | V2              | |
| routes/api.firmData.js        | V2              | |
| routes/api.forms.js           | V2              | |
| routes/api.hooks.js           | V2              | |
| routes/api.intake.js          | V2              | |
| routes/api.jwt.js             | V2              | |
| routes/api.log.js             | V2              | |
| routes/api.search.js          | V2              | |
| routes/api.sending.js         | V2              | |
| routes/api.tasks.js           | V2              | |
| routes/api.users.js           | V2              | |
| routes/auth.login.js          | V2              | |
| routes/auth.password.js       | V2              | |
| routes/auth.profile.js        | V2              | |
| routes/cal.js                 | V2              | /isWorkday is public — add jwtOrApiKey (L7) |
| routes/campaign.js            | V2              | |
| routes/create-case.js         | needs-migration | **L1** — plaintext creds + SQL injection. Replace with POST /api/intake/case |
| routes/db.jwt.js              | V2-ok           | jwtOrApiKey on /db-jwt; used by a.html admin tab (remove per §1) |
| routes/db64.js                | legacy-remove   | **L2** — plaintext creds + arbitrary SQL |
| routes/dbQuery.js             | legacy-keep     | **L3** — /db plaintext creds + arbitrary SQL; delete after callers move |
| routes/dropbox.js             | legacy-keep     | **L5** — plaintext/api_key. Target: delete once callers use /internal/dropbox/* |
| routes/functions.js           | legacy-keep     | /date, /myip, /parseName utilities |
| routes/internal.js            | V2              | |
| routes/internal/dropbox.js    | V2              | |
| routes/internal/email.js      | V2              | |
| routes/internal/gcal.js       | V2              | |
| routes/internal/mms.js        | V2              | |
| routes/internal/sequence.js   | V2              | |
| routes/internal/sms.js        | V2              | |
| routes/logs.js                | legacy-keep     | /logEmail email-relay webhook intake |
| routes/manuals.js             | V2              | |
| routes/pages.js               | legacy-keep     | trivial static routes; prune individually if unused |
| routes/process_jobs.js        | V2              | |
| routes/resolver.js            | V2-ok           | POST /resolve, replaces /unplacehold |
| routes/ringcentral.js         | legacy-keep     | **L6** — x-api-key only; acceptable if internal-only |
| routes/scheduled_jobs.js      | V2              | |
| routes/sequences.js           | V2              | |
| routes/temp.jwt.js            | V2              | |
| routes/temp_auth_validate.js  | legacy-keep     | Pabbly bridge (JWT or plaintext creds); sunset with the rest |
| routes/test_wf_advance.js     | V2              | |
| routes/unplacehold.js         | legacy-keep     | **L4** — plaintext creds. Replace with POST /resolve |
| routes/upload.js              | V2-ok           | |
| routes/workflows.js           | V2              | |

---

## Total files: 130

> Was 129; `public/css/yc-forms.css` was missing from the inventory.

---

# Cutover blocker & loose ends in a.html

- **Cutover blocker (see review.md §1):** Admin "mySQL Query (legacy)" tab at a.html:1540 + panel/iframe at ~:1572–1583 is the only a.html reference to a DB-shaped route (`/db-jwt`). Remove it, then drop the plaintext-password cache in `AUTH_STATE` (TODO comments at ~:1460 and ~:1845).
- **Dead admin button:** `testSwalPage()` at a.html:1473 loads `/testswalpage.html` which does not exist. Delete button at :1540 and function at :1473.

---

# Routes (jwtOrApiKey check)

| Method | Route                                      | jwtOrApiKey | Note (see review.md §4) |
| ------ | ------------------------------------------ | ----------- | ----------------------- |
| GET    | /:page                                     |             | static HTML loader — intentional |
| POST   | /admin/db/query                            | ✔           | |
| GET    | /admin/db/schema                           | ✔           | |
| GET    | /admin/db/schema.sql                       | ✔           | |
| POST   | /admin/db/schema/save-to-ref               | ✔           | |
| GET    | /admin/db/saved-queries                    | ✔           | |
| POST   | /admin/db/saved-queries                    | ✔           | |
| PUT    | /admin/db/saved-queries/:id                | ✔           | |
| DELETE | /admin/db/saved-queries/:id                | ✔           | |
| GET    | /test-alert-bom                            |             | **L8** — dev-only test, should gate to ENVIRONMENT=development |
| GET    | /test-alert                                |             | **L8** — dev-only test, should gate to ENVIRONMENT=development |
| GET    | /api/appts                                 | ✔           | |
| GET    | /api/appts/:id                             | ✔           | |
| PATCH  | /api/appts/:id                             | ✔           | |
| POST   | /api/appts                                 | ✔           | |
| POST   | /api/appts/:id/attended                    | ✔           | |
| POST   | /api/appts/:id/no-show                     | ✔           | |
| POST   | /api/appts/cancel                          | ✔           | |
| POST   | /api/appts/reschedule                      | ✔           | |
| GET    | /api/cases                                 | ✔           | |
| GET    | /api/cases/:id                             | ✔           | |
| PATCH  | /api/cases/:id                             | ✔           | |
| GET    | /api/cases/:id/contacts                    | ✔           | |
| POST   | /api/cases/:id/contacts                    | ✔           | |
| DELETE | /api/cases/:id/contacts/:contactId         | ✔           | |
| GET    | /api/cases/:id/tasks                       | ✔           | |
| GET    | /api/cases/:id/log                         | ✔           | |
| PATCH  | /api/cases/:id/contacts/:contactId         | ✔           | |
| GET    | /checklists                                | ✔           | |
| GET    | /checklists/:id                            | ✔           | |
| POST   | /checklists                                | ✔           | |
| PATCH  | /checklists/:id                            | ✔           | |
| DELETE | /checklists/:id                            | ✔           | |
| POST   | /checklists/:id/items                      | ✔           | |
| PATCH  | /checkitems/:id                            | ✔           | |
| DELETE | /checkitems/:id                            | ✔           | |
| POST   | /checklists/upsert-items                   | ✔           | |
| GET    | /api/public/docs/:caseId                   |             | public doc portal — intentional |
| POST   | /api/public/get-upload-link                |             | public doc portal — intentional |
| POST   | /api/public/upload-complete                |             | public doc portal — intentional |
| GET    | /api/contacts                              | ✔           | |
| GET    | /api/contacts/:id                          | ✔           | |
| POST   | /api/contacts                              | ✔           | |
| PATCH  | /api/contacts/:id                          | ✔           | |
| GET    | /api/contacts/:id/cases                    | ✔           | |
| GET    | /api/contacts/:id/appts                    | ✔           | |
| GET    | /api/contacts/:id/tasks                    | ✔           | |
| GET    | /api/contacts/:id/log                      | ✔           | |
| GET    | /api/contacts/:id/sequences                | ✔           | |
| GET    | /api/contacts/:id/workflows                | ✔           | |
| GET    | /api/feature-requests                      | ✔           | |
| POST   | /api/feature-requests                      | ✔           | |
| POST   | /api/feature-requests/:id/vote             | ✔           | |
| PATCH  | /api/feature-requests/:id                  | ✔           | |
| GET    | /api/feature-requests/:id/comments         | ✔           | |
| POST   | /api/feature-requests/:id/comments         | ✔           | |
| GET    | /api/firm-data                             | ✔           | |
| GET    | /api/forms/latest                          | ✔           | |
| POST   | /api/forms/draft                           | ✔           | |
| POST   | /api/forms/submit                          | ✔           | |
| DELETE | /api/forms/draft                           | ✔           | |
| GET    | /api/forms/history                         | ✔           | |
| POST   | /hooks/:slug                               |             | external webhook, HMAC-verified per-hook |
| GET    | /api/hooks                                 | ✔           | |
| GET    | /api/hooks/meta                            | ✔           | |
| GET    | /api/hooks/:id                             | ✔           | |
| POST   | /api/hooks                                 | ✔           | |
| PUT    | /api/hooks/:id                             | ✔           | |
| DELETE | /api/hooks/:id                             | ✔           | |
| GET    | /api/hooks/:hookId/targets                 | ✔           | |
| POST   | /api/hooks/:hookId/targets                 | ✔           | |
| PUT    | /api/hooks/targets/:id                     | ✔           | |
| DELETE | /api/hooks/targets/:id                     | ✔           | |
| POST   | /api/hooks/:id/test                        | ✔           | |
| POST   | /api/hooks/:id/live-test                   | ✔           | |
| POST   | /api/hooks/:id/capture/start               | ✔           | |
| POST   | /api/hooks/:id/capture/stop                | ✔           | |
| GET    | /api/hooks/:hookId/executions              | ✔           | |
| GET    | /api/hooks/executions/:id                  | ✔           | |
| GET    | /api/credentials                           | ✔           | |
| POST   | /api/credentials                           | ✔           | |
| PUT    | /api/credentials/:id                       | ✔           | |
| DELETE | /api/credentials/:id                       | ✔           | |
| POST   | /api/intake/contact                        | ✔           | |
| POST   | /api/intake/case                           | ✔           | V2 replacement for /create-case |
| GET    | /auth/validate                             | ✔           | |
| GET    | /api/cause_error                           | ✔           | |
| GET    | /clio-code                                 | ✔           | |
| GET    | /api/events                                | ✔           | used by calendar.html |
| GET    | /api/log                                   | ✔           | |
| GET    | /api/log/:id                               | ✔           | |
| POST   | /api/log                                   | ✔           | |
| GET    | /api/search                                | ✔           | |
| GET    | /api/phone-lines                           | ✔           | |
| GET    | /api/email-from                            | ✔           | |
| POST   | /api/compose-docs-message                  | ✔           | |
| GET    | /api/tasks                                 | ✔           | |
| GET    | /api/tasks/:id(\d+)                        | ✔           | |
| POST   | /api/tasks                                 | ✔           | |
| PATCH  | /api/tasks/:id(\d+)                        | ✔           | |
| PATCH  | /api/tasks/:id(\d+)/complete               | ✔           | |
| PATCH  | /api/tasks/:id(\d+)/delete                 | ✔           | |
| PATCH  | /api/tasks/:id(\d+)/reopen                 | ✔           | |
| PATCH  | /api/tasks/:id(\d+)/transfer               | ✔           | |
| GET    | /api/users/me                              | ✔           | |
| GET    | /api/users                                 | ✔           | |
| GET    | /api/users/:id                             | ✔           | |
| GET    | /api/judges                                | ✔           | |
| GET    | /api/trustees                              | ✔           | |
| POST   | /login                                     |             | pre-auth — intentional, rate-limited |
| POST   | /auth/forgot-password                      |             | pre-auth — intentional, rate-limited |
| POST   | /auth/reset-password                       |             | pre-auth — intentional, rate-limited |
| POST   | /api/auth/change-password                  | ✔           | |
| POST   | /api/auth/update-profile                   | ✔           | |
| GET    | /isWorkday                                 |             | **L7** — add jwtOrApiKey |
| POST   | /nextBusinessDay                           | ✔           | |
| POST   | /prevBusinessDay                           | ✔           | |
| GET    | /api/campaigns/contacts                    | ✔           | |
| POST   | /api/campaigns/preview                     | ✔           | |
| POST   | /api/campaigns                             | ✔           | |
| GET    | /api/campaigns                             | ✔           | |
| GET    | /api/campaigns/:id                         | ✔           | |
| GET    | /api/campaigns/:id/results                 | ✔           | |
| PATCH  | /api/campaigns/:id                         | ✔           | |
| POST   | /create-case                               |             | **L1** — plaintext creds + SQL injection |
| GET    | /db-jwt                                    | ✔           | only DB route a.html uses (admin tab) — remove per §1 |
| GET    | /db64                                      |             | **L2** — plaintext creds + arbitrary SQL |
| GET    | /db                                        |             | **L3** — plaintext creds + arbitrary SQL |
| POST   | /dropbox/create-folder                     |             | **L5** — plaintext/api_key |
| POST   | /dropbox/delete                            |             | **L5** |
| POST   | /dropbox/rename                            |             | **L5** |
| POST   | /dropbox/move                              |             | **L5** |
| GET    | /date                                      |             | utility — intentional |
| GET    | /myip                                      |             | utility — intentional |
| GET    | /parseName                                 |             | utility — intentional |
| POST   | /internal/dropbox/create-folder            | ✔           | |
| GET    | /internal/hello                            |             | liveness — intentional |
| POST   | /internal/email/send                       | ✔           | |
| POST   | /internal/gcal/create                      | ✔           | |
| POST   | /internal/gcal/delete                      | ✔           | |
| POST   | /internal/mms/send                         | ✔           | |
| POST   | /internal/sequence/enroll                  | ✔           | |
| POST   | /internal/sms/send                         | ✔           | |
| POST   | /logEmail                                  |             | email-relay webhook — document + keep or gate |
| GET    | /manual                                    | ✔           | |
| GET    | /manual/:section                           | ✔           | |
| GET    | /manual/:section/:file                     | ✔           | |
| GET    | /api                                       |             | info page — intentional |
| GET    | /appt                                      |             | info page — intentional |
| GET    | /docs                                      |             | info page — intentional |
| GET    | /newpath                                   |             | info page — intentional |
| _ALL   | /process-jobs                              | ✔           | |
| POST   | /resolve                                   | ✔           | V2 replacement for /unplacehold |
| GET    | /resolve/tables                            | ✔           | |
| _ALL   | /ringcentral/send-sms                      |             | **L6** — x-api-key only; acceptable if truly internal |
| POST   | /ringcentral/send-mms                      |             | **L6** — x-api-key only |
| GET    | /ringcentral/status                        |             | x-api-key only |
| GET    | /ringcentral/authorize                     |             | OAuth callback — intentional |
| GET    | /ringcentral/callback                      |             | OAuth callback — intentional |
| POST   | /scheduled-jobs                            | ✔           | |
| GET    | /scheduled-jobs/:id                        | ✔           | |
| GET    | /scheduled-jobs                            | ✔           | |
| PATCH  | /scheduled-jobs/:id                        | ✔           | |
| DELETE | /scheduled-jobs/:id                        | ✔           | |
| GET    | /sequences/templates                       | ✔           | |
| GET    | /sequences/templates/:id                   | ✔           | |
| POST   | /sequences/templates                       | ✔           | |
| PUT    | /sequences/templates/:id                   | ✔           | |
| DELETE | /sequences/templates/:id                   | ✔           | |
| POST   | /sequences/templates/:id/duplicate         | ✔           | |
| POST   | /sequences/templates/:id/steps             | ✔           | |
| PUT    | /sequences/templates/:id/steps/:stepNumber | ✔           | |
| PATCH  | /sequences/templates/:id/steps/:stepNumber | ✔           | |
| DELETE | /sequences/templates/:id/steps/:stepNumber | ✔           | |
| POST   | /sequences/enroll                          | ✔           | |
| POST   | /sequences/cancel                          | ✔           | |
| GET    | /sequences/templates/:id/enrollments       | ✔           | |
| GET    | /sequences/enrollments                     | ✔           | |
| GET    | /sequences/enrollments/:id                 | ✔           | |
| POST   | /sequences/enrollments/:id/cancel          | ✔           | |
| PATCH  | /sequences/templates/:id/steps/reorder     | ✔           | |
| GET    | /api/leads                                 | ✔           | |
| POST   | /auth/P_validate                           |             | Pabbly bridge — intentional, rate-limited |
| POST   | /test-advance/:executionId                 | ✔           | |
| POST   | /unplacehold                               |             | **L4** — plaintext creds. Replace with POST /resolve |
| POST   | /api/upload                                | ✔           | |
| GET    | /api/image-library                         | ✔           | |
| POST   | /api/image-library                         | ✔           | |
| DELETE | /api/image-library/:id                     | ✔           | |
| GET    | /workflows/functions                       | ✔           | |
| POST   | /workflows/:id/start                       | ✔           | |
| GET    | /executions                                | ✔           | |
| GET    | /executions/:id                            | ✔           | |
| GET    | /workflows/:id/executions                  | ✔           | |
| GET    | /workflows                                 | ✔           | |
| GET    | /workflows/:id                             | ✔           | |
| POST   | /workflows                                 | ✔           | |
| POST   | /workflows/:id/steps                       | ✔           | |
| POST   | /workflows/bulk                            | ✔           | |
| DELETE | /workflows/:id                             | ✔           | |
| DELETE | /workflows/:id/steps/:stepNumber           | ✔           | |
| PATCH  | /workflows/:id/steps/reorder               | ✔           | |
| PUT    | /workflows/:id                             | ✔           | |
| PUT    | /workflows/:id/steps/:stepNumber           | ✔           | |
| PATCH  | /workflows/:id/steps/:stepNumber           | ✔           | |
| POST   | /workflows/:id/duplicate                   | ✔           | |
| POST   | /executions/:id/cancel                     | ✔           | |
| POST   | /workflows/test-step                       | ✔           | |

---
