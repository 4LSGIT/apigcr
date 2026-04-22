# Files

## scripts (3)

| File                                | Status |
| ----------------------------------- | ------ |
| scripts/backfill-password-hashes.js |        |
| scripts/backfillAppts.js            |        |
| scripts/backfillCampaignContacts.js |        |

---

## lib (10)

| File                       | Status |
| -------------------------- | ------ |
| lib/auth.jwtOrApiKey.js    |   V2   |
| lib/auth.superuser.js      |   V2   |
| lib/credentialInjection.js |   V2   |
| lib/internal_functions.js  |   V2   |
| lib/job_executor.js        |   V2   |
| lib/logMeta.js             |        |
| lib/parseName.js           |        |
| lib/sequenceEngine.js      |   V2   |
| lib/unplacehold.js         |        |
| lib/workflow_engine.js     |   V2   |

---

## services (22)

| File                           | Status |
| ------------------------------ | ------ |
| services/apptService.js        |   V2   |
| services/calendarService.js    |   V2   |
| services/campaignService.js    |   V2   |
| services/caseService.js        |   V2   |
| services/contactService.js     |   V2   |
| services/dropboxService.js     |        |
| services/emailService.js       |   V2   |
| services/formService.js        |   V2   |
| services/hookFilter.js         |   V2   |
| services/hookMapper.js         |   V2   |
| services/hookService.js        |   V2   |
| services/hookTransforms.js     |   V2   |
| services/logService.js         |   V2   |
| services/pabblyService.js      |   V2   |
| services/quoService.js         |   V2   |
| services/resolverService.js    |        |
| services/ringcentralService.js |        |
| services/searchService.js      |   V2   |
| services/settingsService.js    |        |
| services/smsService.js         |   V2   |
| services/taskService.js        |   V2   |
| services/timezoneService.js    |   V2   |

---

## public (41)

| File                                 | Status |
| ------------------------------------ | ------ |
| public/a.html                        |   V2   |
| public/appt.html                     |        |
| public/apptform.html                 |        |
| public/apptform2.html                |   V2   |
| public/automation/hooks.html         |   V2   |
| public/automation/scheduledJobs.html |   V2   |
| public/automation/sequences.html     |   V2   |
| public/automation/workflows.html     |   V2   |
| public/automationManager.html        |   V2   |
| public/calendar.html                 |        |
| public/caltest.html                  |        |
| public/campaign.html                 |   V2   |
| public/case.html                     |        |
| public/case2.html                    |   V2   |
| public/caseerror.html                |        |
| public/communicate.html              |   V2   |
| public/contact.html                  |        |
| public/contact2.html                 |   V2   |
| public/contactform.html              |        |
| public/dbConsole.html                |   V2   |
| public/docReq.html                   |   V2   |
| public/docs.html                     |        |
| public/featureRequests.html          |   V2   |
| public/feedback.html                 |        |
| public/forms/341notes.html           |   V2   |
| public/forms/casedetails.html        |   V2   |
| public/forms/contact-form.html       |   V2   |
| public/forms/issn.html               |   V2   |
| public/index.html                    |        |
| public/js/yc-forms.js                |   V2   |
| public/manuals.html                  |   V2   |
| public/mms.html                      |        |
| public/rating.html                   |        |
| public/reset-password.html           |   V2   |
| public/scripts.js                    |        |
| public/send-sms.html                 |        |
| public/sendingform.html              |   V2   |
| public/styleOpts.html                |        |
| public/survey.html                   |        |
| public/tabLeads.html                 |   V2   |
| public/uploader.html                 |        |

---

## startup (2)

| File            | Status |
| --------------- | ------ |
| startup/db.js   |   V2   |
| startup/init.js |   V2   |

---

## tests (2)

| File                     | Status |
| ------------------------ | ------ |
| tests/test-cron.js       |        |
| tests/test_classifier.js |        |

----

## routes (49)

| File                          | Status |
| ----------------------------- | ------ |
| routes/admin.dbConsole.js     |   V2   |
| routes/alert-test.js          |  safe  |
| routes/api.appts.js           |   V2   |
| routes/api.cases.js           |   V2   |
| routes/api.checklists.js      |   V2   |
| routes/api.contacts.js        |   V2   |
| routes/api.featureRequests.js |   V2   |
| routes/api.firmData.js        |   V2   |
| routes/api.forms.js           |   V2   |
| routes/api.hooks.js           |   V2   |
| routes/api.intake.js          |   V2   |
| routes/api.jwt.js             |   V2   |
| routes/api.log.js             |   V2   |
| routes/api.search.js          |   V2   |
| routes/api.sending.js         |   V2   |
| routes/api.tasks.js           |   V2   |
| routes/api.users.js           |   V2   |
| routes/auth.login.js          |   V2   |
| routes/auth.password.js       |   V2   |
| routes/auth.profile.js        |   V2   |
| routes/cal.js                 |   V2   |
| routes/campaign.js            |   V2   |
| routes/create-case.js         |        |
| routes/db.jwt.js              |        |
| routes/db64.js                |        |
| routes/dbQuery.js             |        |
| routes/dropbox.js             |        |
| routes/functions.js           |        |
| routes/internal.js            |   V2   |
| routes/internal/dropbox.js    |   V2   |
| routes/internal/email.js      |   V2   |
| routes/internal/gcal.js       |   V2   |
| routes/internal/mms.js        |   V2   |
| routes/internal/sequence.js   |   V2   |
| routes/internal/sms.js        |   V2   |
| routes/logs.js                | needed |
| routes/manuals.js             |   V2   |
| routes/pages.js               |        |
| routes/process_jobs.js        |   V2   |
| routes/resolver.js            |        |
| routes/ringcentral.js         |        |
| routes/scheduled_jobs.js      |   V2   |
| routes/sequences.js           |   V2   |
| routes/temp.jwt.js            |   V2   |
| routes/temp_auth_validate.js  |        |
| routes/test_wf_advance.js     |   V2   |
| routes/unplacehold.js         |        |
| routes/upload.js              |        |
| routes/workflows.js           |   V2   |

---

## Total files: 129



# routes:
---

# Routes (jwtOrApiKey check)

| Method | Route                                      | jwtOrApiKey |
| ------ | ------------------------------------------ | ----------- |
| GET    | /:page                                     |             |
| POST   | /admin/db/query                            | ✔           |
| GET    | /admin/db/schema                           | ✔           |
| GET    | /admin/db/schema.sql                       | ✔           |
| POST   | /admin/db/schema/save-to-ref               | ✔           |
| GET    | /admin/db/saved-queries                    | ✔           |
| POST   | /admin/db/saved-queries                    | ✔           |
| PUT    | /admin/db/saved-queries/:id                | ✔           |
| DELETE | /admin/db/saved-queries/:id                | ✔           |
| GET    | /test-alert-bom                            |             |
| GET    | /test-alert                                |             |
| GET    | /api/appts                                 | ✔           |
| GET    | /api/appts/:id                             | ✔           |
| PATCH  | /api/appts/:id                             | ✔           |
| POST   | /api/appts                                 | ✔           |
| POST   | /api/appts/:id/attended                    | ✔           |
| POST   | /api/appts/:id/no-show                     | ✔           |
| POST   | /api/appts/cancel                          | ✔           |
| POST   | /api/appts/reschedule                      | ✔           |
| GET    | /api/cases                                 | ✔           |
| GET    | /api/cases/:id                             | ✔           |
| PATCH  | /api/cases/:id                             | ✔           |
| GET    | /api/cases/:id/contacts                    | ✔           |
| POST   | /api/cases/:id/contacts                    | ✔           |
| DELETE | /api/cases/:id/contacts/:contactId         | ✔           |
| GET    | /api/cases/:id/tasks                       | ✔           |
| GET    | /api/cases/:id/log                         | ✔           |
| PATCH  | /api/cases/:id/contacts/:contactId         | ✔           |
| GET    | /checklists                                | ✔           |
| GET    | /checklists/:id                            | ✔           |
| POST   | /checklists                                | ✔           |
| PATCH  | /checklists/:id                            | ✔           |
| DELETE | /checklists/:id                            | ✔           |
| POST   | /checklists/:id/items                      | ✔           |
| PATCH  | /checkitems/:id                            | ✔           |
| DELETE | /checkitems/:id                            | ✔           |
| POST   | /checklists/upsert-items                   | ✔           |
| GET    | /api/public/docs/:caseId                   |             |
| POST   | /api/public/get-upload-link                |             |
| POST   | /api/public/upload-complete                |             |
| GET    | /api/contacts                              | ✔           |
| GET    | /api/contacts/:id                          | ✔           |
| POST   | /api/contacts                              | ✔           |
| PATCH  | /api/contacts/:id                          | ✔           |
| GET    | /api/contacts/:id/cases                    | ✔           |
| GET    | /api/contacts/:id/appts                    | ✔           |
| GET    | /api/contacts/:id/tasks                    | ✔           |
| GET    | /api/contacts/:id/log                      | ✔           |
| GET    | /api/contacts/:id/sequences                | ✔           |
| GET    | /api/contacts/:id/workflows                | ✔           |
| GET    | /api/feature-requests                      | ✔           |
| POST   | /api/feature-requests                      | ✔           |
| POST   | /api/feature-requests/:id/vote             | ✔           |
| PATCH  | /api/feature-requests/:id                  | ✔           |
| GET    | /api/feature-requests/:id/comments         | ✔           |
| POST   | /api/feature-requests/:id/comments         | ✔           |
| GET    | /api/firm-data                             | ✔           |
| GET    | /api/forms/latest                          | ✔           |
| POST   | /api/forms/draft                           | ✔           |
| POST   | /api/forms/submit                          | ✔           |
| DELETE | /api/forms/draft                           | ✔           |
| GET    | /api/forms/history                         | ✔           |
| POST   | /hooks/:slug                               |             |
| GET    | /api/hooks                                 | ✔           |
| GET    | /api/hooks/meta                            | ✔           |
| GET    | /api/hooks/:id                             | ✔           |
| POST   | /api/hooks                                 | ✔           |
| PUT    | /api/hooks/:id                             | ✔           |
| DELETE | /api/hooks/:id                             | ✔           |
| GET    | /api/hooks/:hookId/targets                 | ✔           |
| POST   | /api/hooks/:hookId/targets                 | ✔           |
| PUT    | /api/hooks/targets/:id                     | ✔           |
| DELETE | /api/hooks/targets/:id                     | ✔           |
| POST   | /api/hooks/:id/test                        | ✔           |
| POST   | /api/hooks/:id/live-test                   | ✔           |
| POST   | /api/hooks/:id/capture/start               | ✔           |
| POST   | /api/hooks/:id/capture/stop                | ✔           |
| GET    | /api/hooks/:hookId/executions              | ✔           |
| GET    | /api/hooks/executions/:id                  | ✔           |
| GET    | /api/credentials                           | ✔           |
| POST   | /api/credentials                           | ✔           |
| PUT    | /api/credentials/:id                       | ✔           |
| DELETE | /api/credentials/:id                       | ✔           |
| POST   | /api/intake/contact                        | ✔           |
| POST   | /api/intake/case                           | ✔           |
| GET    | /auth/validate                             | ✔           |
| GET    | /api/cause_error                           | ✔           |
| GET    | /clio-code                                 | ✔           |
| GET    | /api/events                                | ✔           |
| GET    | /api/log                                   | ✔           |
| GET    | /api/log/:id                               | ✔           |
| POST   | /api/log                                   | ✔           |
| GET    | /api/search                                | ✔           |
| GET    | /api/phone-lines                           | ✔           |
| GET    | /api/email-from                            | ✔           |
| POST   | /api/compose-docs-message                  | ✔           |
| GET    | /api/tasks                                 | ✔           |
| GET    | /api/tasks/:id(\d+)                        | ✔           |
| POST   | /api/tasks                                 | ✔           |
| PATCH  | /api/tasks/:id(\d+)                        | ✔           |
| PATCH  | /api/tasks/:id(\d+)/complete               | ✔           |
| PATCH  | /api/tasks/:id(\d+)/delete                 | ✔           |
| PATCH  | /api/tasks/:id(\d+)/reopen                 | ✔           |
| PATCH  | /api/tasks/:id(\d+)/transfer               | ✔           |
| GET    | /api/users/me                              | ✔           |
| GET    | /api/users                                 | ✔           |
| GET    | /api/users/:id                             | ✔           |
| GET    | /api/judges                                | ✔           |
| GET    | /api/trustees                              | ✔           |
| POST   | /login                                     |             |
| POST   | /auth/forgot-password                      |             |
| POST   | /auth/reset-password                       |             |
| POST   | /api/auth/change-password                  | ✔           |
| POST   | /api/auth/update-profile                   | ✔           |
| GET    | /isWorkday                                 |             |
| POST   | /nextBusinessDay                           | ✔           |
| POST   | /prevBusinessDay                           | ✔           |
| GET    | /api/campaigns/contacts                    | ✔           |
| POST   | /api/campaigns/preview                     | ✔           |
| POST   | /api/campaigns                             | ✔           |
| GET    | /api/campaigns                             | ✔           |
| GET    | /api/campaigns/:id                         | ✔           |
| GET    | /api/campaigns/:id/results                 | ✔           |
| PATCH  | /api/campaigns/:id                         | ✔           |
| POST   | /create-case                               |             |
| GET    | /db-jwt                                    | ✔           |
| GET    | /db64                                      |             |
| GET    | /db                                        |             |
| POST   | /dropbox/create-folder                     |             |
| POST   | /dropbox/delete                            |             |
| POST   | /dropbox/rename                            |             |
| POST   | /dropbox/move                              |             |
| GET    | /date                                      |             |
| GET    | /myip                                      |             |
| GET    | /parseName                                 |             |
| POST   | /internal/dropbox/create-folder            | ✔           |
| GET    | /internal/hello                            |             |
| POST   | /internal/email/send                       | ✔           |
| POST   | /internal/gcal/create                      | ✔           |
| POST   | /internal/gcal/delete                      | ✔           |
| POST   | /internal/mms/send                         | ✔           |
| POST   | /internal/sequence/enroll                  | ✔           |
| POST   | /internal/sms/send                         | ✔           |
| POST   | /logEmail                                  |             |
| GET    | /manual                                    | ✔           |
| GET    | /manual/:section                           | ✔           |
| GET    | /manual/:section/:file                     | ✔           |
| GET    | /api                                       |             |
| GET    | /appt                                      |             |
| GET    | /docs                                      |             |
| GET    | /newpath                                   |             |
| _ALL   | /process-jobs                              | ✔           |
| POST   | /resolve                                   | ✔           |
| GET    | /resolve/tables                            | ✔           |
| _ALL   | /ringcentral/send-sms                      |             |
| POST   | /ringcentral/send-mms                      |             |
| GET    | /ringcentral/status                        |             |
| GET    | /ringcentral/authorize                     |             |
| GET    | /ringcentral/callback                      |             |
| POST   | /scheduled-jobs                            | ✔           |
| GET    | /scheduled-jobs/:id                        | ✔           |
| GET    | /scheduled-jobs                            | ✔           |
| PATCH  | /scheduled-jobs/:id                        | ✔           |
| DELETE | /scheduled-jobs/:id                        | ✔           |
| GET    | /sequences/templates                       | ✔           |
| GET    | /sequences/templates/:id                   | ✔           |
| POST   | /sequences/templates                       | ✔           |
| PUT    | /sequences/templates/:id                   | ✔           |
| DELETE | /sequences/templates/:id                   | ✔           |
| POST   | /sequences/templates/:id/duplicate         | ✔           |
| POST   | /sequences/templates/:id/steps             | ✔           |
| PUT    | /sequences/templates/:id/steps/:stepNumber | ✔           |
| PATCH  | /sequences/templates/:id/steps/:stepNumber | ✔           |
| DELETE | /sequences/templates/:id/steps/:stepNumber | ✔           |
| POST   | /sequences/enroll                          | ✔           |
| POST   | /sequences/cancel                          | ✔           |
| GET    | /sequences/templates/:id/enrollments       | ✔           |
| GET    | /sequences/enrollments                     | ✔           |
| GET    | /sequences/enrollments/:id                 | ✔           |
| POST   | /sequences/enrollments/:id/cancel          | ✔           |
| PATCH  | /sequences/templates/:id/steps/reorder     | ✔           |
| GET    | /api/leads                                 | ✔           |
| POST   | /auth/P_validate                           |             |
| POST   | /test-advance/:executionId                 | ✔           |
| POST   | /unplacehold                               |             |
| POST   | /api/upload                                | ✔           |
| GET    | /api/image-library                         | ✔           |
| POST   | /api/image-library                         | ✔           |
| DELETE | /api/image-library/:id                     | ✔           |
| GET    | /workflows/functions                       | ✔           |
| POST   | /workflows/:id/start                       | ✔           |
| GET    | /executions                                | ✔           |
| GET    | /executions/:id                            | ✔           |
| GET    | /workflows/:id/executions                  | ✔           |
| GET    | /workflows                                 | ✔           |
| GET    | /workflows/:id                             | ✔           |
| POST   | /workflows                                 | ✔           |
| POST   | /workflows/:id/steps                       | ✔           |
| POST   | /workflows/bulk                            | ✔           |
| DELETE | /workflows/:id                             | ✔           |
| DELETE | /workflows/:id/steps/:stepNumber           | ✔           |
| PATCH  | /workflows/:id/steps/reorder               | ✔           |
| PUT    | /workflows/:id                             | ✔           |
| PUT    | /workflows/:id/steps/:stepNumber           | ✔           |
| PATCH  | /workflows/:id/steps/:stepNumber           | ✔           |
| POST   | /workflows/:id/duplicate                   | ✔           |
| POST   | /executions/:id/cancel                     | ✔           |
| POST   | /workflows/test-step                       | ✔           |

---
