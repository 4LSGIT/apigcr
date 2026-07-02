# lib/internal_functions/

The internal-function registry: the shared action vocabulary used by
**workflows**, **sequences**, **scheduled jobs**, **YisraHook targets**, and the
**email/phone ingest action dispatchers** (`lib/actionDispatchers.js`). Every
callable here can be invoked as a step/action with the signature
`fn(params, db)` and returns `{ success, output, ... }`.

This directory replaces the old single-file `lib/internal_functions.js`.
`require('../lib/internal_functions')` resolves to `index.js` here — no
consumer changes were needed.

## Convention

- **One file per category** (`contacts.js`, `timing.js`, `court.js`, …). Each
  file exports a plain `{ name: fn }` object:

  ```js
  // lib/internal_functions/widgets.js
  const fns = {};

  fns.frobnicate_widget = async (params, db) => {
    // ...
  };
  fns.frobnicate_widget.__meta = {
    category: 'widgets',
    description: 'One-line summary.',
    params: [
      { name: 'widget_id', type: 'string', required: true, placeholderAllowed: true },
    ],
    example: { widget_id: '{{widgetId}}' },
  };

  module.exports = fns;
  ```

- **`__meta` sits immediately below its implementation.** New functions need a
  `__meta` block — `tests/internal_functions.meta.test.js` enforces the shape.
  (Every function currently has one — `court_extract`, the former lone
  exception, now carries a minimal `uiHidden` meta so the editors filter it
  from pickers via metadata. Any new meta-less exception needs a comment at
  the definition AND an entry in the test's `META_EXEMPT` set.)

- **`index.js` auto-scans this directory** — there is no registration step.
  Drop a new category file in and its exports join the registry at boot.
  Duplicate function names across files throw at boot. Files starting with
  `_` and non-`.js` files are skipped; `_` is reserved for shared helpers if
  one ever genuinely spans categories (none does today — keep helpers inside
  the one category file that uses them).

- **`__meta.category` drives UI grouping and may differ from file placement.**
  File placement follows code cohesion; category follows how the workflow /
  sequence editors group functions. e.g. `court_review_retry` and
  `court_activity_summary` carry `category: 'system'` but live in `court.js`;
  `query_db` carries `'general'` but lives in `db.js`. Do not "fix" a category
  to match its filename.

- **Lazy-require discipline.** Requires carrying circular-dependency comments
  (`// deferred require (circular dep safety)`, `// lazy require (convention)`,
  `// ← lazy require`) MUST stay inside the function bodies — moving them to
  module scope reintroduces the cycles they exist to break (sequenceEngine ↔
  job_executor, apptService, eventService, logService, phoneIngestService,
  courtExecutor, alerting, …). Note path depth from this directory:
  services are `../../services/...`, lib siblings are `../...`.

- Whole-registry changes surface automatically via `GET /workflows/functions`
  (names + `__getAllMeta()`), the email/phone ingest target lists, and the
  apiTester — nothing else to wire.

## `__meta` schema

(Preserved from the old file's metadata-registry header.)

Each function may carry a `__meta` block describing its param shape. Surfaced
to the UI via `GET /workflows/functions` so the workflow + sequence editors can
render real form fields instead of a raw JSON textarea. Save-time validation in
`routes/workflows.js` drives off these blocks too.

Schema fields:

| field | type | meaning |
|---|---|---|
| `category` | string | grouping label (control / timing / …) |
| `description` | string | one-line summary shown above the form |
| `workflowOnly` | boolean | DRIVES the sequence exclusion — `GET /workflows/functions` filters these from the `sequence` list |
| `uiHidden` | boolean | filtered from the workflow/sequence editor pickers (still shown, suffixed "(hidden)", on steps already using the function) |
| `controlFlow` | boolean | advisory; matches `isControlStep` in engine |
| `params` | array | param specs (below) |
| `exclusiveOneOf` | array of `[name,…]` groups | exactly one must be set |
| `requiredWith` | array of `[name,…]` groups | at least one must be set |
| `example` | object | copy/paste starting payload |

Param spec fields:

| field | type | meaning |
|---|---|---|
| `name` | string | `params[name]` in the runtime call |
| `type` | string | see `TYPE_VALIDATORS` (validator in `index.js` / routes) |
| `required` | boolean | save-time required check |
| `placeholderAllowed` | boolean | strings containing `{{var}}` skip type checks |
| `widget` | string | UI rendering hint (`'phone_line'`, `'email_from'`) |
| `multiline` | boolean | UI hint: render as textarea, not `<input>` |
| `description` | string | helper text below the field |
| `example` | any | example value |
| `default` | any | runtime default; informs UI placeholder |
| `enum` | array | for `type:'enum'` |
| `min`, `max` | number | bounds for `type:'number'`/`'integer'` |

## index.js also carries

- The param validator (`__validateParamsAgainstMeta`) plus `__getMeta` /
  `__getAllMeta` — moved verbatim from the old file.
- `__resetFirmNumberCache` — preserved public handle, re-pointed at
  `services/phoneIngestService.resetFirmNumberCache`.
- `court.js` additionally exports the `__summarizeCourtActions` /
  `__buildCourtSummaryHtml` test handles used by `scripts/courtSummaryTest.js`;
  the scanner copies them onto the registry like everything else (`__`-prefixed
  keys are filtered from the UI lists exactly as before).