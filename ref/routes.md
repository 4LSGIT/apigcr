# Routes

_Generated 2026-08-31T11:13:14.727Z_  
_662 routes total — DELETE: 51, GET: 271, PATCH: 43, POST: 261, PUT: 34, _ALL: 2_

## Global middleware chain

1. `query`
2. `expressInit`

## /_aitest

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/_aitest` | `gate` | — |
| GET | `/_aitest/file` | `gate` | — |

## /admin

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/admin/api-tester/history` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/api-tester/saved` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/api-tester/saved` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| DELETE | `/admin/api-tester/saved/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/api-tester/saved/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PUT | `/admin/api-tester/saved/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/api-tester/saved/:id/run` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/api-tester/send-request` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/batch` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/query` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/saved-queries` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/saved-queries` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| DELETE | `/admin/db/saved-queries/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PUT | `/admin/db/saved-queries/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/schema` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/schema.sql` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/schema/save-to-ref` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/elevate` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/system-alerts` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/system-alerts/ack` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/system-alerts/reopen` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/system-alerts/resolve` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |

## /api

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/api` | — | — |
| GET | `/api/admin/users` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/admin/users` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PATCH | `/api/admin/users/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/admin/users/:id/disable` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/admin/users/:id/enable` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/admin/users/:id/set-password` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/ai/file` | `jwtOrApiKey`, `uploadSingle` | — |
| GET | `/api/api-keys` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/api-keys` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/api-keys/:id/log` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/api-keys/:id/revoke` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/api-keys/internal/log` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/api-keys/rejected` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/api-keys/rotate-internal` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/app-settings` | `jwtOrApiKey` | — |
| POST | `/api/app-settings` | `jwtOrApiKey` | — |
| PUT | `/api/app-settings/:key` | `jwtOrApiKey` | — |
| GET | `/api/appts` | `jwtOrApiKey` | — |
| POST | `/api/appts` | `jwtOrApiKey` | — |
| GET | `/api/appts/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/appts/:id` | `jwtOrApiKey` | — |
| POST | `/api/appts/:id/attended` | `jwtOrApiKey` | — |
| POST | `/api/appts/:id/no-show` | `jwtOrApiKey` | — |
| POST | `/api/appts/cancel` | `jwtOrApiKey` | — |
| POST | `/api/appts/reschedule` | `jwtOrApiKey` | — |
| GET | `/api/assets` | `jwtOrApiKey` | — |
| POST | `/api/assets` | `jwtOrApiKey` | — |
| DELETE | `/api/assets/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/assets/:id` | `jwtOrApiKey` | — |
| GET | `/api/assets/collections` | `jwtOrApiKey` | — |
| POST | `/api/auth/change-password` | `jwtOrApiKey` | — |
| POST | `/api/auth/update-custom-tab` | `jwtOrApiKey` | — |
| POST | `/api/auth/update-profile` | `jwtOrApiKey` | — |
| GET | `/api/availability` | `jwtOrApiKey` | — |
| GET | `/api/availability-blocks` | `jwtOrApiKey` | — |
| POST | `/api/availability-blocks` | `jwtOrApiKey` | — |
| DELETE | `/api/availability-blocks/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/availability-blocks/:id` | `jwtOrApiKey` | — |
| POST | `/api/book/:slug` | — | — |
| GET | `/api/book/:slug/config` | — | — |
| GET | `/api/book/:slug/contact` | — | — |
| GET | `/api/book/:slug/slots` | — | — |
| GET | `/api/booking-views` | `jwtOrApiKey` | — |
| POST | `/api/booking-views` | `jwtOrApiKey` | — |
| DELETE | `/api/booking-views/:id` | `jwtOrApiKey` | — |
| GET | `/api/booking-views/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/booking-views/:id` | `jwtOrApiKey` | — |
| GET | `/api/booking-views/providers` | `jwtOrApiKey` | — |
| GET | `/api/calendar-feed` | `jwtOrApiKey` | — |
| GET | `/api/campaigns` | `jwtOrApiKey` | — |
| POST | `/api/campaigns` | `jwtOrApiKey` | — |
| GET | `/api/campaigns/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/campaigns/:id` | `jwtOrApiKey` | — |
| GET | `/api/campaigns/:id/results` | `jwtOrApiKey` | — |
| GET | `/api/campaigns/contacts` | `jwtOrApiKey` | — |
| POST | `/api/campaigns/preview` | `jwtOrApiKey` | — |
| GET | `/api/cases` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/cases/:id` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/contacts` | `jwtOrApiKey` | — |
| POST | `/api/cases/:id/contacts` | `jwtOrApiKey` | — |
| DELETE | `/api/cases/:id/contacts/:contactId` | `jwtOrApiKey` | — |
| PATCH | `/api/cases/:id/contacts/:contactId` | `jwtOrApiKey` | — |
| PATCH | `/api/cases/:id/docket` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/log` | `jwtOrApiKey` | — |
| POST | `/api/cases/:id/merge` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/pipeline` | `jwtOrApiKey` | — |
| POST | `/api/cases/:id/pipeline/advance` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/pipeline/requirements` | `jwtOrApiKey` | — |
| DELETE | `/api/cases/:id/pipeline/requirements/:key/override` | `jwtOrApiKey` | — |
| POST | `/api/cases/:id/pipeline/requirements/:key/override` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/sequences` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/tasks` | `jwtOrApiKey` | — |
| GET | `/api/cases/:id/workflows` | `jwtOrApiKey` | — |
| GET | `/api/cases/search` | `jwtOrApiKey` | — |
| GET | `/api/cause_error` | `jwtOrApiKey` | — |
| POST | `/api/compose-docs-message` | `jwtOrApiKey` | — |
| POST | `/api/contact-addresses` | `jwtOrApiKey` | — |
| DELETE | `/api/contact-addresses/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/contact-addresses/:id` | `jwtOrApiKey` | — |
| POST | `/api/contact-emails` | `jwtOrApiKey` | — |
| DELETE | `/api/contact-emails/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/contact-emails/:id` | `jwtOrApiKey` | — |
| GET | `/api/contact-lookup` | `jwtOrApiKey` | — |
| POST | `/api/contact-phones` | `jwtOrApiKey` | — |
| DELETE | `/api/contact-phones/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/contact-phones/:id` | `jwtOrApiKey` | — |
| POST | `/api/contact-relations` | `jwtOrApiKey` | — |
| DELETE | `/api/contact-relations/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/contact-relations/:id` | `jwtOrApiKey` | — |
| GET | `/api/contacts` | `jwtOrApiKey` | — |
| POST | `/api/contacts` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/contacts/:id` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/addresses` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/appts` | `jwtOrApiKey` | — |
| POST | `/api/contacts/:id/booking-link` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/cases` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/emails` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/log` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/phones` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/relations` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/sequences` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/tasks` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/workflows` | `jwtOrApiKey` | — |
| GET | `/api/court-preview/emails` | `jwtOrApiKey` | — |
| GET | `/api/court-preview/prompt` | `jwtOrApiKey` | — |
| POST | `/api/court-preview/run` | `jwtOrApiKey` | — |
| POST | `/api/court-review/adopt-rerun` | `jwtOrApiKey` | — |
| POST | `/api/court-review/approve` | `jwtOrApiKey` | — |
| POST | `/api/court-review/dismiss` | `jwtOrApiKey` | — |
| POST | `/api/court-review/force-apply` | `jwtOrApiKey` | — |
| GET | `/api/court-review/item/:id` | `jwtOrApiKey` | — |
| GET | `/api/court-review/queue` | `jwtOrApiKey` | — |
| POST | `/api/court-review/reextract` | `jwtOrApiKey` | — |
| POST | `/api/court-review/rerun` | `jwtOrApiKey` | — |
| POST | `/api/court/free-look` | `jwtOrApiKey` | — |
| GET | `/api/credentials` | `jwtOrApiKey` | `listCredentials` |
| POST | `/api/credentials` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | `createCredential` |
| DELETE | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | `deleteCredential` |
| GET | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | `getCredential` |
| PUT | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | `updateCredential` |
| POST | `/api/credentials/:id/authorize` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/credentials/:id/refresh` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/credentials/:id/reveal` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/credentials/:id/revoke` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/documents` | `jwtOrApiKey` | — |
| GET | `/api/documents/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/documents/:id` | `jwtOrApiKey` | — |
| DELETE | `/api/documents/:id/links` | `jwtOrApiKey` | — |
| POST | `/api/documents/:id/links` | `jwtOrApiKey` | — |
| GET | `/api/documents/:id/raw` | `jwtOrApiKey` | — |
| POST | `/api/documents/:id/share` | `jwtOrApiKey` | — |
| GET | `/api/documents/:id/view` | `jwtOrApiKey` | — |
| POST | `/api/documents/register` | `jwtOrApiKey` | — |
| POST | `/api/documents/relink` | `jwtOrApiKey` | — |
| GET | `/api/documents/relink/:caseId/candidates` | `jwtOrApiKey` | — |
| POST | `/api/documents/relink/dismiss` | `jwtOrApiKey` | — |
| GET | `/api/documents/relink/queue` | `jwtOrApiKey` | — |
| GET | `/api/documents/sync-diagnostics` | `jwtOrApiKey` | — |
| POST | `/api/documents/sync-diagnostics` | `jwtOrApiKey` | — |
| GET | `/api/documents/sync-roots` | `jwtOrApiKey` | — |
| POST | `/api/documents/sync-roots` | `jwtOrApiKey` | — |
| PATCH | `/api/documents/sync-roots/:id` | `jwtOrApiKey` | — |
| POST | `/api/documents/sync-roots/:id/sync` | `jwtOrApiKey` | — |
| POST | `/api/documents/upload-commit` | `jwtOrApiKey` | — |
| POST | `/api/documents/upload-link` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/create-folder` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/delete` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/download` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/list` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/move` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/rename` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/save-url` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/save-url-status` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/shared-link` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/shared-link-metadata` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/upload` | `jwtOrApiKey` | — |
| POST | `/api/dropbox/upload-link` | `jwtOrApiKey` | — |
| GET | `/api/email-credentials` | `jwtOrApiKey` | — |
| POST | `/api/email-credentials` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PUT | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id/reveal` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/email-credentials/:id/test` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id/verify-aliases` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-from` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/executions` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/executions/:id` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/meta` | `jwtOrApiKey` | — |
| DELETE | `/api/email-ingest/rule-actions/:id` | `jwtOrApiKey` | — |
| PUT | `/api/email-ingest/rule-actions/:id` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/rules` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/rules` | `jwtOrApiKey` | — |
| DELETE | `/api/email-ingest/rules/:id` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/rules/:id` | `jwtOrApiKey` | — |
| PUT | `/api/email-ingest/rules/:id` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/rules/:id/actions` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/rules/:id/duplicate` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/rules/test-match` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/rules/test-transform` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/sample-events` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/suppressions` | `jwtOrApiKey` | — |
| POST | `/api/email-ingest/suppressions` | `jwtOrApiKey` | — |
| DELETE | `/api/email-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| GET | `/api/email-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| PUT | `/api/email-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| POST | `/api/email-router/capture/start` | `jwtOrApiKey` | — |
| POST | `/api/email-router/capture/stop` | `jwtOrApiKey` | — |
| GET | `/api/email-router/captured-sample` | `jwtOrApiKey` | — |
| GET | `/api/email-router/config` | `jwtOrApiKey` | — |
| PUT | `/api/email-router/config` | `jwtOrApiKey` | — |
| GET | `/api/email-router/executions` | `jwtOrApiKey` | — |
| GET | `/api/email-router/executions/:id` | `jwtOrApiKey` | — |
| POST | `/api/email-router/match-test` | `jwtOrApiKey` | — |
| POST | `/api/email-router/preview` | `jwtOrApiKey` | — |
| GET | `/api/email-router/routes` | `jwtOrApiKey` | — |
| POST | `/api/email-router/routes` | `jwtOrApiKey` | — |
| DELETE | `/api/email-router/routes/:id` | `jwtOrApiKey` | — |
| GET | `/api/email-router/routes/:id` | `jwtOrApiKey` | — |
| PUT | `/api/email-router/routes/:id` | `jwtOrApiKey` | — |
| POST | `/api/email/ingest` | `<anonymous>` | — |
| GET | `/api/esign` | `jwtOrApiKey` | — |
| GET | `/api/esign/:id(\d+)` | `jwtOrApiKey` | — |
| GET | `/api/esign/:id(\d+)/source` | `jwtOrApiKey` | — |
| POST | `/api/esign/:id/recall` | `jwtOrApiKey` | — |
| POST | `/api/esign/:id/remind` | `jwtOrApiKey` | — |
| POST | `/api/esign/:id/resend` | `jwtOrApiKey`, `uploadSingle` | — |
| POST | `/api/esign/:id/satisfied-external` | `jwtOrApiKey`, `uploadSingle` | — |
| POST | `/api/esign/inline-images` | `jwtOrApiKey` | — |
| POST | `/api/esign/resolve-prefills` | `jwtOrApiKey` | — |
| POST | `/api/esign/send` | `jwtOrApiKey`, `uploadSingle` | — |
| POST | `/api/esign/send-from-template` | `jwtOrApiKey` | — |
| GET | `/api/esign/template-meta` | `jwtOrApiKey` | — |
| GET | `/api/esign/templates` | `jwtOrApiKey` | — |
| POST | `/api/esign/templates` | `jwtOrApiKey` | — |
| GET | `/api/esign/templates/:id` | `jwtOrApiKey` | — |
| PUT | `/api/esign/templates/:id` | `jwtOrApiKey` | — |
| POST | `/api/esign/templates/:id/deactivate` | `jwtOrApiKey` | — |
| GET | `/api/esign/templates/:id/pdf` | `jwtOrApiKey` | — |
| POST | `/api/esign/templates/:id/pdf` | `jwtOrApiKey`, `tplUploadSingle` | — |
| POST | `/api/esign/templates/:id/prefills` | `jwtOrApiKey` | — |
| POST | `/api/esign/templates/:id/preview` | `jwtOrApiKey` | — |
| GET | `/api/events` | `jwtOrApiKey` | — |
| GET | `/api/events` | `jwtOrApiKey` | — |
| POST | `/api/events` | `jwtOrApiKey` | — |
| GET | `/api/events/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)/cancel` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)/complete` | `jwtOrApiKey` | — |
| POST | `/api/events/batch` | `jwtOrApiKey` | — |
| GET | `/api/ext/forms/:form_key` | — | — |
| POST | `/api/ext/forms/:form_key/submit` | — | — |
| GET | `/api/feature-requests` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests` | `jwtOrApiKey` | — |
| PATCH | `/api/feature-requests/:id` | `jwtOrApiKey`, `requireAdmin` | — |
| GET | `/api/feature-requests/:id/comments` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests/:id/comments` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests/:id/vote` | `jwtOrApiKey` | — |
| GET | `/api/firm-blocks` | `jwtOrApiKey` | — |
| POST | `/api/firm-blocks` | `jwtOrApiKey` | — |
| DELETE | `/api/firm-blocks/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/firm-blocks/:id` | `jwtOrApiKey` | — |
| GET | `/api/firm-data` | `jwtOrApiKey` | — |
| GET | `/api/form-templates` | `jwtOrApiKey` | — |
| POST | `/api/form-templates` | `jwtOrApiKey` | — |
| DELETE | `/api/form-templates/:id` | `jwtOrApiKey` | — |
| GET | `/api/form-templates/:id` | `jwtOrApiKey` | — |
| PUT | `/api/form-templates/:id` | `jwtOrApiKey` | — |
| POST | `/api/form-templates/:id/publish` | `jwtOrApiKey` | — |
| GET | `/api/form-templates/:id/versions` | `jwtOrApiKey` | — |
| GET | `/api/form-templates/:id/versions/:versionId` | `jwtOrApiKey` | — |
| POST | `/api/form-templates/:id/versions/:versionId/restore` | `jwtOrApiKey` | — |
| POST | `/api/form-templates/:id/visibility` | `jwtOrApiKey` | — |
| GET | `/api/form-templates/render/:form_key` | `jwtOrApiKey` | — |
| DELETE | `/api/forms/draft` | `jwtOrApiKey` | — |
| POST | `/api/forms/draft` | `jwtOrApiKey` | — |
| GET | `/api/forms/history` | `jwtOrApiKey` | — |
| GET | `/api/forms/latest` | `jwtOrApiKey` | — |
| GET | `/api/forms/submissions` | `jwtOrApiKey` | — |
| GET | `/api/forms/submissions/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/forms/submissions/:id/link` | `jwtOrApiKey` | — |
| GET | `/api/forms/submissions/:id/pdf` | `jwtOrApiKey` | — |
| POST | `/api/forms/submissions/:id/pdf/file` | `jwtOrApiKey` | — |
| GET | `/api/forms/submissions/:id/render` | `jwtOrApiKey` | — |
| POST | `/api/forms/submit` | `jwtOrApiKey` | — |
| GET | `/api/gcal/calendars` | `jwtOrApiKey` | — |
| GET | `/api/gcal/events` | `jwtOrApiKey` | — |
| POST | `/api/gcal/events` | `jwtOrApiKey` | — |
| DELETE | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
| GET | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
| GET | `/api/gcontacts/connections` | `jwtOrApiKey` | — |
| POST | `/api/gcontacts/ensure-group` | `jwtOrApiKey` | — |
| POST | `/api/gcontacts/import-links` | `jwtOrApiKey` | — |
| POST | `/api/gcontacts/push/:contactId` | `jwtOrApiKey` | — |
| POST | `/api/gcontacts/sync-pending` | `jwtOrApiKey` | — |
| GET | `/api/hooks` | `jwtOrApiKey` | — |
| POST | `/api/hooks` | `jwtOrApiKey` | — |
| GET | `/api/hooks/:hookId/executions` | `jwtOrApiKey` | — |
| GET | `/api/hooks/:hookId/targets` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:hookId/targets` | `jwtOrApiKey` | — |
| DELETE | `/api/hooks/:id` | `jwtOrApiKey` | — |
| GET | `/api/hooks/:id` | `jwtOrApiKey` | — |
| PUT | `/api/hooks/:id` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/capture/start` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/capture/stop` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/duplicate` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/live-test` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/test` | `jwtOrApiKey` | — |
| GET | `/api/hooks/executions` | `jwtOrApiKey` | — |
| GET | `/api/hooks/executions/:id` | `jwtOrApiKey` | — |
| GET | `/api/hooks/meta` | `jwtOrApiKey` | — |
| DELETE | `/api/hooks/targets/:id` | `jwtOrApiKey` | — |
| PUT | `/api/hooks/targets/:id` | `jwtOrApiKey` | — |
| POST | `/api/hooks/test-transform` | `jwtOrApiKey` | — |
| POST | `/api/intake/case` | `jwtOrApiKey` | — |
| POST | `/api/intake/contact` | `jwtOrApiKey` | — |
| POST | `/api/intake/petition` | `jwtOrApiKey` | — |
| GET | `/api/issue-reports` | `jwtOrApiKey`, `requireAdmin` | — |
| POST | `/api/issue-reports` | `jwtOrApiKey` | — |
| GET | `/api/issue-reports/:id` | `jwtOrApiKey`, `requireAdmin` | — |
| POST | `/api/issue-reports/resolve` | `jwtOrApiKey`, `requireAdmin` | — |
| GET | `/api/judges` | `jwtOrApiKey` | — |
| GET | `/api/log` | `jwtOrApiKey` | — |
| POST | `/api/log` | `jwtOrApiKey` | — |
| GET | `/api/log/:id` | `jwtOrApiKey` | — |
| PUT | `/api/log/:id/about` | `jwtOrApiKey` | — |
| GET | `/api/log/case-docket-preview` | `jwtOrApiKey` | — |
| GET | `/api/log/orphan-earliest` | `jwtOrApiKey` | — |
| GET | `/api/m/:token` | — | — |
| POST | `/api/m/:token/cancel` | — | — |
| POST | `/api/m/:token/reschedule` | — | — |
| GET | `/api/m/:token/slots` | — | — |
| GET | `/api/manage-config` | — | — |
| GET | `/api/me/signatures` | `jwtOrApiKey` | — |
| PUT | `/api/me/signatures/:id` | `jwtOrApiKey` | — |
| GET | `/api/pages` | `jwtOrApiKey` | — |
| POST | `/api/pages` | `jwtOrApiKey` | — |
| DELETE | `/api/pages/:id` | `jwtOrApiKey` | — |
| GET | `/api/pages/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/pages/:id` | `jwtOrApiKey` | — |
| POST | `/api/pages/:id/create-hook` | `jwtOrApiKey` | — |
| POST | `/api/pdf/parse` | `jwtOrApiKey`, `multerMiddleware` | — |
| GET | `/api/phone-ingest/executions` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/executions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/meta` | `jwtOrApiKey` | — |
| DELETE | `/api/phone-ingest/rule-actions/:id` | `jwtOrApiKey` | — |
| PUT | `/api/phone-ingest/rule-actions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/rules` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/rules` | `jwtOrApiKey` | — |
| DELETE | `/api/phone-ingest/rules/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/rules/:id` | `jwtOrApiKey` | — |
| PUT | `/api/phone-ingest/rules/:id` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/rules/:id/actions` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/rules/:id/duplicate` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/rules/test-match` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/rules/test-transform` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/sample-events` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/suppressions` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/suppressions` | `jwtOrApiKey` | — |
| DELETE | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| PUT | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-lines` | `jwtOrApiKey` | — |
| GET | `/api/phone-lines/admin` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/phone-lines/admin` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PUT | `/api/phone-lines/admin/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PATCH | `/api/phone-lines/admin/:id/active` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| PATCH | `/api/phone-lines/admin/:id/mms-capable` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/phone-lines/admin/:id/test-sms` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/pipeline-admin/detectors` | `jwtOrApiKey` | — |
| DELETE | `/api/pipeline-admin/requirements/:id` | `jwtOrApiKey` | — |
| PUT | `/api/pipeline-admin/requirements/:id` | `jwtOrApiKey` | — |
| DELETE | `/api/pipeline-admin/stages/:id` | `jwtOrApiKey` | — |
| PUT | `/api/pipeline-admin/stages/:id` | `jwtOrApiKey` | — |
| GET | `/api/pipeline-admin/stages/:id/requirements` | `jwtOrApiKey` | — |
| POST | `/api/pipeline-admin/stages/:id/requirements` | `jwtOrApiKey` | — |
| POST | `/api/pipeline-admin/stages/:id/requirements/reorder` | `jwtOrApiKey` | — |
| GET | `/api/pipeline-admin/templates` | `jwtOrApiKey` | — |
| POST | `/api/pipeline-admin/templates` | `jwtOrApiKey` | — |
| DELETE | `/api/pipeline-admin/templates/:id` | `jwtOrApiKey` | — |
| PUT | `/api/pipeline-admin/templates/:id` | `jwtOrApiKey` | — |
| GET | `/api/pipeline-admin/templates/:id/stages` | `jwtOrApiKey` | — |
| POST | `/api/pipeline-admin/templates/:id/stages` | `jwtOrApiKey` | — |
| POST | `/api/pipeline-admin/templates/:id/stages/reorder` | `jwtOrApiKey` | — |
| GET | `/api/pipeline-admin/usage` | `jwtOrApiKey` | — |
| GET | `/api/pipeline-board` | `jwtOrApiKey` | — |
| GET | `/api/portal-access-admin/contacts` | `jwtOrApiKey` | — |
| PUT | `/api/portal-access-admin/contacts/:id` | `jwtOrApiKey` | — |
| POST | `/api/portal-access-admin/contacts/:id/force-logout` | `jwtOrApiKey` | — |
| GET | `/api/portal-cards-admin/cards` | `jwtOrApiKey` | — |
| POST | `/api/portal-cards-admin/cards` | `jwtOrApiKey` | — |
| DELETE | `/api/portal-cards-admin/cards/:id` | `jwtOrApiKey` | — |
| GET | `/api/portal-cards-admin/cards/:id` | `jwtOrApiKey` | — |
| PUT | `/api/portal-cards-admin/cards/:id` | `jwtOrApiKey` | — |
| GET | `/api/portal-cards-admin/meta` | `jwtOrApiKey` | — |
| POST | `/api/portal-cards-admin/preview` | `jwtOrApiKey` | — |
| GET | `/api/portal/branding` | — | `brandingHandler` |
| GET | `/api/portal/callback` | `contactMiddleware` | — |
| POST | `/api/portal/callback` | `contactMiddleware` | — |
| POST | `/api/portal/callback/cancel` | `contactMiddleware` | — |
| GET | `/api/portal/cases` | `contactMiddleware` | — |
| GET | `/api/portal/cases/:caseId` | `contactMiddleware` | — |
| GET | `/api/portal/cases/:caseId/docs` | `contactMiddleware` | — |
| POST | `/api/portal/cases/:caseId/docs/upload-complete` | `contactMiddleware` | — |
| POST | `/api/portal/cases/:caseId/docs/upload-link` | `contactMiddleware` | — |
| GET | `/api/portal/home` | `contactMiddleware` | — |
| POST | `/api/portal/logout` | `contactMiddleware` | — |
| GET | `/api/portal/me` | `contactMiddleware` | — |
| POST | `/api/portal/request-pin` | — | — |
| POST | `/api/portal/verify-pin` | — | — |
| GET | `/api/public/docs/:caseId` | `<anonymous>` | — |
| POST | `/api/public/get-upload-link` | `<anonymous>` | — |
| POST | `/api/public/upload-complete` | `<anonymous>` | — |
| GET | `/api/readonly-keys` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/readonly-keys` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/readonly-keys/:id` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/readonly-keys/:id/log` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/readonly/sql` | `readonlyApiKeyAuth` | — |
| GET | `/api/redirects` | `jwtOrApiKey` | — |
| POST | `/api/redirects` | `jwtOrApiKey` | — |
| DELETE | `/api/redirects/:id` | `jwtOrApiKey` | — |
| GET | `/api/redirects/:id` | `jwtOrApiKey` | — |
| PUT | `/api/redirects/:id` | `jwtOrApiKey` | — |
| GET | `/api/relation-types` | `jwtOrApiKey` | — |
| GET | `/api/reports` | `jwtOrApiKey` | — |
| POST | `/api/reports` | `jwtOrApiKey`, `requireUser` | — |
| DELETE | `/api/reports/:id(\d+)` | `jwtOrApiKey`, `requireUser` | — |
| GET | `/api/reports/:id(\d+)` | `jwtOrApiKey` | — |
| PUT | `/api/reports/:id(\d+)` | `jwtOrApiKey`, `requireUser` | — |
| POST | `/api/reports/:id(\d+)/lock` | `jwtOrApiKey`, `requireUser` | — |
| POST | `/api/reports/:id(\d+)/run` | `jwtOrApiKey` | — |
| GET | `/api/reports/:id(\d+)/runs` | `jwtOrApiKey` | — |
| GET | `/api/reports/:id(\d+)/versions` | `jwtOrApiKey` | — |
| GET | `/api/reports/:id(\d+)/versions/:v(\d+)` | `jwtOrApiKey` | — |
| POST | `/api/reports/:id(\d+)/versions/:v(\d+)/restore` | `jwtOrApiKey`, `requireUser` | — |
| POST | `/api/reports/draft` | `jwtOrApiKey`, `requireUser`, `limitDraft` | — |
| POST | `/api/reports/preview` | `jwtOrApiKey`, `requireUser`, `limitPreview` | — |
| GET | `/api/reports/runs` | `jwtOrApiKey` | — |
| GET | `/api/reports/schema` | `jwtOrApiKey` | — |
| DELETE | `/api/scratch/:ns` | `readonlyApiKeyAuth` | — |
| DELETE | `/api/scratch/:ns/:k` | `readonlyApiKeyAuth` | — |
| PUT | `/api/scratch/:ns/:k` | `readonlyApiKeyAuth` | — |
| GET | `/api/search` | `jwtOrApiKey` | — |
| GET | `/api/sequence-types` | `jwtOrApiKey` | — |
| POST | `/api/sequence-types` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/sequence-types/:type` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| GET | `/api/sequence-types/:type` | `jwtOrApiKey` | — |
| PUT | `/api/sequence-types/:type` | `jwtOrApiKey`, `superuserCheck`, `elevationCheck`, `rateLimitMiddleware` | — |
| POST | `/api/streak/auth/:slug` | `<anonymous>`, `memberAuth` | — |
| GET | `/api/streak/board/:slug` | `<anonymous>`, `memberAuth` | — |
| DELETE | `/api/streak/board/:slug/checkin` | `<anonymous>`, `memberAuth` | — |
| POST | `/api/streak/board/:slug/checkin` | `<anonymous>`, `memberAuth` | — |
| POST | `/api/streak/board/:slug/message` | `<anonymous>`, `memberAuth` | — |
| DELETE | `/api/streak/board/:slug/message/:id` | `<anonymous>`, `memberAuth` | — |
| GET | `/api/streak/board/:slug/messages` | `<anonymous>`, `memberAuth` | — |
| GET | `/api/streak/boards` | `<anonymous>`, `adminAuth` | — |
| POST | `/api/streak/boards` | `<anonymous>`, `adminAuth` | — |
| DELETE | `/api/streak/boards/:slug` | `<anonymous>`, `adminAuth` | — |
| PATCH | `/api/streak/boards/:slug` | `<anonymous>`, `adminAuth` | — |
| GET | `/api/streak/meta/:slug` | `<anonymous>` | — |
| GET | `/api/system-status` | `jwtOrApiKey` | — |
| GET | `/api/tasks` | `jwtOrApiKey` | — |
| POST | `/api/tasks` | `jwtOrApiKey` | — |
| GET | `/api/tasks/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/complete` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/delete` | `jwtOrApiKey` | — |
| GET | `/api/tasks/:id(\d+)/history` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/reopen` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/transfer` | `jwtOrApiKey` | — |
| POST | `/api/temp/clio/request` | `readonlyApiKeyAuth` | — |
| GET | `/api/temp/clio/whoami` | `readonlyApiKeyAuth` | — |
| POST | `/api/temp/dropbox/request` | `readonlyApiKeyAuth` | — |
| GET | `/api/temp/dropbox/whoami` | `readonlyApiKeyAuth` | — |
| GET | `/api/temp/ringcentral/probe` | `readonlyApiKeyAuth` | — |
| POST | `/api/temp/ringcentral/request` | `readonlyApiKeyAuth` | — |
| GET | `/api/temp/ringcentral/whoami` | `readonlyApiKeyAuth` | — |
| POST | `/api/temp/zohosign/request` | `readonlyApiKeyAuth` | — |
| GET | `/api/triggers/events` | `jwtOrApiKey` | — |
| GET | `/api/triggers/executions` | `jwtOrApiKey` | — |
| GET | `/api/triggers/executions/:id` | `jwtOrApiKey` | — |
| GET | `/api/triggers/meta` | `jwtOrApiKey` | — |
| POST | `/api/triggers/replay` | `jwtOrApiKey` | — |
| GET | `/api/triggers/rules` | `jwtOrApiKey` | — |
| POST | `/api/triggers/rules` | `jwtOrApiKey` | — |
| DELETE | `/api/triggers/rules/:id` | `jwtOrApiKey` | — |
| GET | `/api/triggers/rules/:id` | `jwtOrApiKey` | — |
| PUT | `/api/triggers/rules/:id` | `jwtOrApiKey` | — |
| GET | `/api/triggers/rules/:id/history` | `jwtOrApiKey` | — |
| GET | `/api/triggers/samples/:event_type` | `jwtOrApiKey` | — |
| POST | `/api/triggers/test` | `jwtOrApiKey` | — |
| POST | `/api/triggers/test-draft` | `jwtOrApiKey` | — |
| GET | `/api/trustees` | `jwtOrApiKey` | — |
| GET | `/api/user-availability` | `jwtOrApiKey` | — |
| POST | `/api/user-availability` | `jwtOrApiKey` | — |
| DELETE | `/api/user-availability/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/user-availability/:id` | `jwtOrApiKey` | — |
| GET | `/api/users` | `jwtOrApiKey` | — |
| GET | `/api/users/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/users/:id/freebusy-calendars` | `jwtOrApiKey` | — |
| GET | `/api/users/me` | `jwtOrApiKey` | — |
| POST | `/api/v/:slug/cta-click` | — | — |
| POST | `/api/v/:slug/track` | — | — |
| GET | `/api/version` | — | — |
| GET | `/api/videos` | `jwtOrApiKey` | — |
| POST | `/api/videos` | `jwtOrApiKey` | — |
| DELETE | `/api/videos/:id` | `jwtOrApiKey` | — |
| GET | `/api/videos/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/videos/:id` | `jwtOrApiKey` | — |
| GET | `/api/videos/:id/analytics` | `jwtOrApiKey` | — |
| POST | `/api/videos/:id/reset-analytics` | `jwtOrApiKey` | — |
| POST | `/api/videos/upload-asset` | `jwtOrApiKey` | — |

## /appt

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/appt` | — | — |

## /auth

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/auth/forgot-password` | `<anonymous>` | — |
| GET | `/auth/oauth/callback` | — | — |
| POST | `/auth/P_validate` | `<anonymous>` | — |
| POST | `/auth/reset-password` | `<anonymous>` | — |
| GET | `/auth/validate` | `jwtOrApiKey` | — |

## /badge

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/badge/ask` | — | — |
| GET | `/badge/last.wav` | — | — |

## /book

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/book/:slug,/b/:slug` | — | — |

## /checkitems

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| DELETE | `/checkitems/:id` | `jwtOrApiKey` | — |
| PATCH | `/checkitems/:id` | `jwtOrApiKey` | — |

## /checklists

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/checklists` | `jwtOrApiKey` | — |
| POST | `/checklists` | `jwtOrApiKey` | — |
| DELETE | `/checklists/:id` | `jwtOrApiKey` | — |
| GET | `/checklists/:id` | `jwtOrApiKey` | — |
| PATCH | `/checklists/:id` | `jwtOrApiKey` | — |
| POST | `/checklists/:id/items` | `jwtOrApiKey` | — |
| POST | `/checklists/upsert-items` | `jwtOrApiKey` | — |

## /clio-code

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/clio-code` | `jwtOrApiKey` | — |

## /d

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/d/:token([A-Za-z0-9_\-]{10,40})` | — | — |
| GET | `/d/:token([A-Za-z0-9_\-]{10,40})/:value([A-Za-z0-9_\-]{1,64})` | — | — |
| POST | `/d/:token([A-Za-z0-9_\-]{10,40})/respond` | — | — |

## /date

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/date` | — | — |

## /db

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/db` | `<anonymous>` | — |

## /db-jwt

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/db-jwt` | `jwtOrApiKey` | — |

## /db64

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/db64` | `<anonymous>` | — |

## /docs

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/docs` | — | — |

## /dropbox

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/dropbox/create-folder` | `<anonymous>` | — |
| POST | `/dropbox/delete` | `<anonymous>` | — |
| POST | `/dropbox/move` | `<anonymous>` | — |
| POST | `/dropbox/rename` | `<anonymous>` | — |

## /email-router

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/email-router` | `<anonymous>` | — |

## /executions

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/executions` | `jwtOrApiKey` | — |
| GET | `/executions/:id` | `jwtOrApiKey` | — |
| POST | `/executions/:id/cancel` | `jwtOrApiKey` | — |
| POST | `/executions/:id/resume` | `jwtOrApiKey` | — |

## /f

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/f/:form_key` | — | — |

## /hooks

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/hooks/:slug` | `<anonymous>` | — |

## /internal

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/internal/dropbox/create-folder` | `jwtOrApiKey` | — |
| GET | `/internal/email-test/credentials` | `jwtOrApiKey` | — |
| GET | `/internal/email-test/credentials/oauth` | `jwtOrApiKey` | — |
| POST | `/internal/email-test/send` | `jwtOrApiKey` | — |
| POST | `/internal/email/send` | `jwtOrApiKey` | — |
| GET | `/internal/hello` | — | — |
| POST | `/internal/mms/send` | `jwtOrApiKey` | — |
| GET | `/internal/phone-test/lines` | `jwtOrApiKey` | — |
| POST | `/internal/phone-test/mms` | `jwtOrApiKey` | — |
| POST | `/internal/phone-test/sms` | `jwtOrApiKey` | — |
| POST | `/internal/sequence/enroll` | `jwtOrApiKey` | — |
| POST | `/internal/sms/send` | `jwtOrApiKey` | — |

## /isworkday

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/isWorkday` | `<anonymous>` | — |

## /logemail

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/logEmail` | `<anonymous>` | — |

## /login

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/login` | `<anonymous>` | — |

## /m

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/m` | — | `serveManageShell` |
| GET | `/m/:token` | — | `serveManageShell` |

## /manual

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/manual` | `jwtOrApiKey` | — |
| GET | `/manual/:section` | `jwtOrApiKey` | — |
| GET | `/manual/:section/:file` | `jwtOrApiKey` | — |

## /myip

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/myip` | — | — |

## /newpath

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/newpath` | — | — |

## /nextbusinessday

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/nextBusinessDay` | `jwtOrApiKey` | — |

## /p

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/p/:slug` | — | — |
| POST | `/p/:slug` | — | — |

## /p,

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/p,/p/` | — | — |
| POST | `/p,/p/` | — | — |

## /parsename

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/parseName` | — | — |

## /prevbusinessday

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/prevBusinessDay` | `jwtOrApiKey` | — |

## /process-domain-event

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/process-domain-event/:id` | `jwtOrApiKey` | — |

## /process-job

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/process-job/:id` | `jwtOrApiKey` | — |

## /process-jobs

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| _ALL | `/process-jobs` | `jwtOrApiKey` | — |

## /r

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/r/:slug` | `<anonymous>` | — |

## /resolve

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/resolve` | `jwtOrApiKey` | — |
| GET | `/resolve/tables` | `jwtOrApiKey` | — |

## /ringcentral

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/ringcentral/send-mms` | `<anonymous>`, `checkApiKey` | — |
| _ALL | `/ringcentral/send-sms` | `<anonymous>`, `checkApiKey` | — |

## /scheduled-jobs

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/scheduled-jobs` | `jwtOrApiKey` | — |
| POST | `/scheduled-jobs` | `jwtOrApiKey` | — |
| DELETE | `/scheduled-jobs/:id` | `jwtOrApiKey` | — |
| GET | `/scheduled-jobs/:id` | `jwtOrApiKey` | — |
| PATCH | `/scheduled-jobs/:id` | `jwtOrApiKey` | — |
| PATCH | `/scheduled-jobs/:id/active` | `jwtOrApiKey` | — |

## /sequences

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/sequences/cancel` | `jwtOrApiKey` | — |
| POST | `/sequences/enroll` | `jwtOrApiKey` | — |
| GET | `/sequences/enrollments` | `jwtOrApiKey` | — |
| GET | `/sequences/enrollments/:id` | `jwtOrApiKey` | — |
| POST | `/sequences/enrollments/:id/cancel` | `jwtOrApiKey` | — |
| POST | `/sequences/enrollments/:id/fire-next` | `jwtOrApiKey` | — |
| POST | `/sequences/enrollments/:id/recover` | `jwtOrApiKey` | — |
| POST | `/sequences/preview` | `jwtOrApiKey` | — |
| GET | `/sequences/step-log` | `jwtOrApiKey` | — |
| GET | `/sequences/templates` | `jwtOrApiKey` | — |
| POST | `/sequences/templates` | `jwtOrApiKey` | — |
| DELETE | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| PUT | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/capture/start` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/capture/stop` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id/captured` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/discard-draft` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id/draft-diff` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/duplicate` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id/enrollments` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/publish` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/steps` | `jwtOrApiKey` | — |
| DELETE | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PUT | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/sequences/templates/:id/steps/reorder` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id/versions` | `jwtOrApiKey` | — |

## /t

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/t/:token([A-Za-z0-9_\-]{10,40})` | — | — |
| POST | `/t/:token([A-Za-z0-9_\-]{10,40})/cancel` | — | — |
| POST | `/t/:token([A-Za-z0-9_\-]{10,40})/complete` | — | — |
| GET | `/t/:token([A-Za-z0-9_\-]{10,40})/status.svg` | — | — |

## /test-advance

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/test-advance/:executionId` | `jwtOrApiKey` | — |

## /test-alert

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/test-alert` | — | — |

## /test-alert-bom

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/test-alert-bom` | — | — |

## /unplacehold

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/unplacehold` | `<anonymous>` | — |

## /v

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/v/:slug` | — | — |

## /webhooks

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/webhooks/esign/zoho` | `<anonymous>`, `textParser` | — |

## /workflows

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/workflows` | `jwtOrApiKey` | — |
| POST | `/workflows` | `jwtOrApiKey` | — |
| DELETE | `/workflows/:id` | `jwtOrApiKey` | — |
| GET | `/workflows/:id` | `jwtOrApiKey` | — |
| PUT | `/workflows/:id` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/capture/start` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/capture/stop` | `jwtOrApiKey` | — |
| GET | `/workflows/:id/captured` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/discard-draft` | `jwtOrApiKey` | — |
| GET | `/workflows/:id/draft-diff` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/duplicate` | `jwtOrApiKey` | — |
| GET | `/workflows/:id/executions` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/publish` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/start` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/steps` | `jwtOrApiKey` | — |
| DELETE | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PUT | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/workflows/:id/steps/reorder` | `jwtOrApiKey` | — |
| GET | `/workflows/:id/versions` | `jwtOrApiKey` | — |
| POST | `/workflows/bulk` | `jwtOrApiKey` | — |
| GET | `/workflows/functions` | `jwtOrApiKey` | — |
| POST | `/workflows/test-step` | `jwtOrApiKey` | — |

---

_662 routes total — DELETE: 51, GET: 271, PATCH: 43, POST: 261, PUT: 34, _ALL: 2_
