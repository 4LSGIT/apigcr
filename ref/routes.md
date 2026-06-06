# Routes

_Generated 2026-06-06T19:27:35.378Z_  
_362 routes total — DELETE: 33, GET: 145, PATCH: 31, POST: 130, PUT: 21, _ALL: 2_

## Global middleware chain

1. `query`
2. `expressInit`

## /admin

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/admin/api-tester/history` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/api-tester/send-request` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/query` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/saved-queries` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/saved-queries` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| DELETE | `/admin/db/saved-queries/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PUT | `/admin/db/saved-queries/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/schema` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/admin/db/schema.sql` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/admin/db/schema/save-to-ref` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |

## /api

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/api` | — | — |
| GET | `/api/appts` | `jwtOrApiKey` | — |
| POST | `/api/appts` | `jwtOrApiKey` | — |
| GET | `/api/appts/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/appts/:id` | `jwtOrApiKey` | — |
| POST | `/api/appts/:id/attended` | `jwtOrApiKey` | — |
| POST | `/api/appts/:id/no-show` | `jwtOrApiKey` | — |
| POST | `/api/appts/cancel` | `jwtOrApiKey` | — |
| POST | `/api/appts/reschedule` | `jwtOrApiKey` | — |
| POST | `/api/auth/change-password` | `jwtOrApiKey` | — |
| POST | `/api/auth/update-profile` | `jwtOrApiKey` | — |
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
| GET | `/api/cases/:id/tasks` | `jwtOrApiKey` | — |
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
| GET | `/api/contacts/:id/cases` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/emails` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/log` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/phones` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/relations` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/sequences` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/tasks` | `jwtOrApiKey` | — |
| GET | `/api/contacts/:id/workflows` | `jwtOrApiKey` | — |
| GET | `/api/credentials` | `jwtOrApiKey` | — |
| POST | `/api/credentials` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PUT | `/api/credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/credentials/:id/authorize` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/credentials/:id/refresh` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/credentials/:id/reveal` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/credentials/:id/revoke` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
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
| POST | `/api/email-credentials` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PUT | `/api/email-credentials/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id/reveal` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/email-credentials/:id/test` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/email-credentials/:id/verify-aliases` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
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
| GET | `/api/events` | `jwtOrApiKey` | — |
| GET | `/api/events` | `jwtOrApiKey` | — |
| POST | `/api/events` | `jwtOrApiKey` | — |
| GET | `/api/events/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)/cancel` | `jwtOrApiKey` | — |
| PATCH | `/api/events/:id(\d+)/complete` | `jwtOrApiKey` | — |
| POST | `/api/events/batch` | `jwtOrApiKey` | — |
| GET | `/api/feature-requests` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests` | `jwtOrApiKey` | — |
| PATCH | `/api/feature-requests/:id` | `jwtOrApiKey`, `requireAdmin` | — |
| GET | `/api/feature-requests/:id/comments` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests/:id/comments` | `jwtOrApiKey` | — |
| POST | `/api/feature-requests/:id/vote` | `jwtOrApiKey` | — |
| GET | `/api/firm-data` | `jwtOrApiKey` | — |
| DELETE | `/api/forms/draft` | `jwtOrApiKey` | — |
| POST | `/api/forms/draft` | `jwtOrApiKey` | — |
| GET | `/api/forms/history` | `jwtOrApiKey` | — |
| GET | `/api/forms/latest` | `jwtOrApiKey` | — |
| POST | `/api/forms/submit` | `jwtOrApiKey` | — |
| GET | `/api/gcal/calendars` | `jwtOrApiKey` | — |
| GET | `/api/gcal/events` | `jwtOrApiKey` | — |
| POST | `/api/gcal/events` | `jwtOrApiKey` | — |
| DELETE | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
| GET | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
| PATCH | `/api/gcal/events/:id` | `jwtOrApiKey` | — |
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
| POST | `/api/hooks/:id/live-test` | `jwtOrApiKey` | — |
| POST | `/api/hooks/:id/test` | `jwtOrApiKey` | — |
| GET | `/api/hooks/executions/:id` | `jwtOrApiKey` | — |
| GET | `/api/hooks/meta` | `jwtOrApiKey` | — |
| DELETE | `/api/hooks/targets/:id` | `jwtOrApiKey` | — |
| PUT | `/api/hooks/targets/:id` | `jwtOrApiKey` | — |
| GET | `/api/image-library` | `jwtOrApiKey` | — |
| POST | `/api/image-library` | `jwtOrApiKey` | — |
| DELETE | `/api/image-library/:id` | `jwtOrApiKey` | — |
| POST | `/api/intake/case` | `jwtOrApiKey` | — |
| POST | `/api/intake/contact` | `jwtOrApiKey` | — |
| POST | `/api/intake/petition` | `jwtOrApiKey` | — |
| GET | `/api/judges` | `jwtOrApiKey` | — |
| GET | `/api/leads` | `jwtOrApiKey` | — |
| GET | `/api/log` | `jwtOrApiKey` | — |
| POST | `/api/log` | `jwtOrApiKey` | — |
| GET | `/api/log/:id` | `jwtOrApiKey` | — |
| GET | `/api/log/case-docket-preview` | `jwtOrApiKey` | — |
| GET | `/api/log/orphan-earliest` | `jwtOrApiKey` | — |
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
| GET | `/api/phone-ingest/sample-events` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/suppressions` | `jwtOrApiKey` | — |
| POST | `/api/phone-ingest/suppressions` | `jwtOrApiKey` | — |
| DELETE | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| PUT | `/api/phone-ingest/suppressions/:id` | `jwtOrApiKey` | — |
| GET | `/api/phone-lines` | `jwtOrApiKey` | — |
| GET | `/api/phone-lines/admin` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/phone-lines/admin` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PUT | `/api/phone-lines/admin/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PATCH | `/api/phone-lines/admin/:id/active` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| PATCH | `/api/phone-lines/admin/:id/mms-capable` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/phone-lines/admin/:id/test-sms` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/public/docs/:caseId` | `<anonymous>` | — |
| POST | `/api/public/get-upload-link` | `<anonymous>` | — |
| POST | `/api/public/upload-complete` | `<anonymous>` | — |
| GET | `/api/readonly-keys` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/readonly-keys` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/readonly-keys/:id` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/readonly-keys/:id/log` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| POST | `/api/readonly/sql` | `readonlyApiKeyAuth` | — |
| GET | `/api/redirects` | `jwtOrApiKey` | — |
| POST | `/api/redirects` | `jwtOrApiKey` | — |
| DELETE | `/api/redirects/:id` | `jwtOrApiKey` | — |
| GET | `/api/redirects/:id` | `jwtOrApiKey` | — |
| PUT | `/api/redirects/:id` | `jwtOrApiKey` | — |
| GET | `/api/relation-types` | `jwtOrApiKey` | — |
| DELETE | `/api/scratch/:ns` | `readonlyApiKeyAuth` | — |
| DELETE | `/api/scratch/:ns/:k` | `readonlyApiKeyAuth` | — |
| PUT | `/api/scratch/:ns/:k` | `readonlyApiKeyAuth` | — |
| GET | `/api/search` | `jwtOrApiKey` | — |
| GET | `/api/sequence-types` | `jwtOrApiKey` | — |
| POST | `/api/sequence-types` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| DELETE | `/api/sequence-types/:type` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/sequence-types/:type` | `jwtOrApiKey` | — |
| PUT | `/api/sequence-types/:type` | `jwtOrApiKey`, `superuserCheck`, `rateLimitMiddleware` | — |
| GET | `/api/tasks` | `jwtOrApiKey` | — |
| POST | `/api/tasks` | `jwtOrApiKey` | — |
| GET | `/api/tasks/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/complete` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/delete` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/reopen` | `jwtOrApiKey` | — |
| PATCH | `/api/tasks/:id(\d+)/transfer` | `jwtOrApiKey` | — |
| GET | `/api/trustees` | `jwtOrApiKey` | — |
| POST | `/api/upload` | `jwtOrApiKey`, `multerMiddleware` | — |
| GET | `/api/users` | `jwtOrApiKey` | — |
| GET | `/api/users/:id` | `jwtOrApiKey` | — |
| GET | `/api/users/me` | `jwtOrApiKey` | — |
| POST | `/api/v/:slug/cta-click` | — | — |
| POST | `/api/v/:slug/track` | — | — |
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

## /create-case

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/create-case` | `<anonymous>` | — |

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

## /parsename

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/parseName` | — | — |

## /prevbusinessday

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| POST | `/prevBusinessDay` | `jwtOrApiKey` | — |

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
| GET | `/sequences/templates` | `jwtOrApiKey` | — |
| POST | `/sequences/templates` | `jwtOrApiKey` | — |
| DELETE | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| PUT | `/sequences/templates/:id` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/duplicate` | `jwtOrApiKey` | — |
| GET | `/sequences/templates/:id/enrollments` | `jwtOrApiKey` | — |
| POST | `/sequences/templates/:id/steps` | `jwtOrApiKey` | — |
| DELETE | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PUT | `/sequences/templates/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/sequences/templates/:id/steps/reorder` | `jwtOrApiKey` | — |

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

## /workflows

| Method | Path | Middlewares | Handler |
|--------|------|-------------|---------|
| GET | `/workflows` | `jwtOrApiKey` | — |
| POST | `/workflows` | `jwtOrApiKey` | — |
| DELETE | `/workflows/:id` | `jwtOrApiKey` | — |
| GET | `/workflows/:id` | `jwtOrApiKey` | — |
| PUT | `/workflows/:id` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/duplicate` | `jwtOrApiKey` | — |
| GET | `/workflows/:id/executions` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/start` | `jwtOrApiKey` | — |
| POST | `/workflows/:id/steps` | `jwtOrApiKey` | — |
| DELETE | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PUT | `/workflows/:id/steps/:stepNumber` | `jwtOrApiKey` | — |
| PATCH | `/workflows/:id/steps/reorder` | `jwtOrApiKey` | — |
| POST | `/workflows/bulk` | `jwtOrApiKey` | — |
| GET | `/workflows/functions` | `jwtOrApiKey` | — |
| POST | `/workflows/test-step` | `jwtOrApiKey` | — |

---

_362 routes total — DELETE: 33, GET: 145, PATCH: 31, POST: 130, PUT: 21, _ALL: 2_
