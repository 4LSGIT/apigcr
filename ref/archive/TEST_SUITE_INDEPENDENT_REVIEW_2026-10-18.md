# Independent test-suite review and prompt for Claude

**Date:** 2026-10-18  
**Audience:** Claude, or another engineer investigating the YisraCase Jest suite  
**Status:** Independent, non-binding review and suggested investigation plan

## Read this first: independence and authority

This report was prepared by an independent investigator. Its measurements are
intended to be reproducible, but its interpretations, classifications and
recommendations are **not final, binding, or instructions to implement
blindly**. They are suggestions and starting points.

Claude should:

1. re-run the measurements in the current checkout;
2. inspect the production and test code behind every proposed change;
3. challenge this report's classifications and suggested boundaries;
4. preserve coverage when it finds a risk this review missed; and
5. make its own reasoned decision about what to keep, consolidate, move or
   remove.

Do not mass-delete tests from counts or filenames alone. A slice-named test may
be the only executable proof of an important invariant. Conversely, a large,
well-commented test can still duplicate later end-state coverage. Verify both.

## Assignment

Investigate and improve the Jest test system. The goals are:

- make the normal development loop substantially faster and less
  resource-intensive;
- stop load-dependent failures from blocking unrelated work;
- distinguish fast deterministic checks from UI simulation, performance,
  real-engine and external-infrastructure tests;
- prune or consolidate obsolete and duplicate coverage without weakening
  security, authorization, data-integrity, migration or regression protection;
- make skipped coverage explicit and intentional; and
- leave a test system whose result is trusted rather than routinely retried.

Explore alternatives to this report's solution. Before changing behavior,
produce a verified coverage/cost map and explain the tradeoffs of the chosen
approach.

## Executive finding

The problem is not simply that Jest is slow. One command currently mixes a
large number of different jobs:

- pure logic tests;
- service tests over scripted database doubles;
- route tests that bind local HTTP servers;
- jsdom tests that boot large portions of the real UI;
- tests that parse or extract functions from production HTML/JavaScript;
- long-running animation, fuzz and performance checks;
- real Chromium/PDF checks;
- real MySQL suites; and
- a real Dovecot/IMAP suite.

The suite has grown from a safety net into a second implementation surface.
The right response is not wholesale deletion. It is to establish execution
lanes, remove accidental real-time waiting, consolidate repeated harnesses,
then prune superseded assertions one feature family at a time.

## Reproducible baseline

### Repository scale

At the reviewed revision:

- 459 `tests/*.test.js` files;
- 13,175 Jest tests in the observed run;
- 12,588 passed and 587 skipped in the clean four-worker run;
- approximately 190,000 lines in the 459 suite files;
- approximately 197,000 tracked lines under `tests/` when helpers and other
  test JavaScript are included;
- approximately 207,000 JavaScript lines in `lib/`, `routes/`, `services/`,
  `startup/` and `public/js/`.

The test code is therefore roughly the size of the main JavaScript application
layers, before counting inline JavaScript in HTML.

### Recent growth

Test files added by month, derived from git additions:

| Month | Added suite files |
|---|---:|
| 2026-04 | 2 |
| 2026-07 | 45 |
| 2026-08 | 115 |
| 2026-09 | 93 |
| 2026-10 through the review date | 210 |

Historical snapshots:

| Revision | Suite files |
|---|---:|
| `HEAD` at review | 459 |
| `HEAD~100` | 370 |
| `HEAD~250` | 257 |
| `HEAD~500` | 207 |

The concern that tests have gradually become a major share of feature work is
supported by repository history.

### Mechanics inventory

Overlapping flags:

| Mechanic | Suite files | Approx. suite-file lines |
|---|---:|---:|
| Instantiates jsdom | 112 | 60,112 |
| Binds an HTTP server with `.listen()` | 102 | 46,654 |
| Reads source/artifact files with `readFileSync` | 197 | 90,037 |
| Contains timing/performance patterns | 22 | 12,831 |
| Uses `new Promise(...setTimeout...)` in tests | 100 | not measured |
| Uses Jest fake timers | 4 | not measured |

An exclusive, mechanics-based partition of the 459 suite files was:

| First matching category | Files | Lines | Approx. statically found tests |
|---|---:|---:|---:|
| External/real-engine oriented | 45 | 16,053 | 803 |
| jsdom, non-external | 111 | 59,808 | 2,781 |
| HTTP, non-jsdom/non-external | 72 | 32,584 | 2,367 |
| Source-reading, none of the above | 53 | 16,108 | 1,110 |
| Other | 178 | 65,692 | 4,588 |

These are investigative categories, not proposed permanent tiers. The static
test count is approximate; Jest's observed total is authoritative.

### Concurrency experiment

The supplied default-worker run used Jest's current nine workers and reported:

- 101.609 seconds wall time;
- two load-sensitive failures;
- 419 passed, 2 failed and 38 skipped suites.

An independent run used:

```bash
npx jest --maxWorkers=4 --json --outputFile=/tmp/apigcr-jest-profile-4w.json
```

It reported:

- 119.853 seconds wall time;
- 421 passed and 38 skipped suites;
- 12,588 passed and 587 skipped tests;
- no failures.

This is one run, not a benchmark series. It suggests a real tradeoff: four
workers reduced contention enough to remove the observed flakes, but made wall
time about 18 seconds longer. Re-run several times before selecting a worker
cap. A middle value may be preferable. Record wall time, peak memory and
failure rate, not only wall time.

The `estimated 381 s` in the supplied Jest output was Jest's cached estimate,
not that run's elapsed time.

## Timing concentration

In the four-worker profile, summed suite duration was about 470 worker-seconds.
Because four suites run concurrently, this is not wall time. Cost was highly
concentrated:

| Slowest group | Share of summed suite duration |
|---|---:|
| Top 5 suites | 22.6% |
| Top 10 suites | 36.0% |
| Top 20 suites | 52.2% |
| Top 26 suites | 59.1% |
| Top 40 suites | 72.1% |

Ten suites exceeded ten seconds; 26 exceeded five seconds; 79 exceeded one
second.

### Slowest suites in the four-worker run

| Duration | Suite | Initial interpretation, to be reverified |
|---:|---|---|
| 26.640 s | `phoneSPH.pane.test.js` | jsdom plus many real 20–900 ms sleeps/debounces |
| 23.946 s | `caseUi.sync.test.js` | full page/jsdom sync-bus integration |
| 20.484 s | `mascotSkins.test.js` | real animation clock; one test already quarantined |
| 18.057 s | `firmTab.test.js` | three-frame jsdom app and real validators |
| 16.957 s | `formRender.x6card.test.js` | real UI timers, including auto-advance |
| 15.100 s | `triggerService.test.js` | one infinite-loop test waits the production 15 s VM timeout |
| 14.008 s | `ctaManager.pane.test.js` | jsdom plus a real HTTP router/server section |
| 12.410 s | `commsArchive.s4.pane.test.js` | full Comms pane jsdom integration |
| 11.525 s | `pipelineBoardUi.sync.test.js` | full page/jsdom sync-bus integration |
| 10.378 s | `mailboxS2.pane.test.js` | broad Comms/email pane jsdom integration |
| 9.763 s | `contactUi.sync.test.js` | full page/jsdom sync-bus integration |
| 8.940 s | `ensureSqlProxy.test.js` | real child processes, ports and waits |
| 8.119 s | `clioTool.test.js` | UI/tool harness |
| 7.485 s | `documentsUi.syncPanel.test.js` | full jsdom sync-panel integration |
| 7.133 s | `launcherS6c5.test.js` | access fuzz dominates |
| 7.078 s | `launcherS5a.test.js` | launcher jsdom/source integration |

Do not infer deletion priority directly from this list. Many of these are
valuable integration checks. It is first a streamlining priority list.

### Slow individual tests with obvious mechanical cost

The JSON profile makes several opportunities concrete:

1. `triggerService.test.js` spends about **15.0 seconds** proving that
   `while(true){}` is stopped. Production's default `CODE_TIMEOUT_MS` is 15
   seconds. The test can probably set `TRIGGER_CODE_TIMEOUT_MS` to a small
   value before requiring the module and still prove the exact invariant.
   Verify that no other assertion in the file depends on the production
   duration.

2. `launcherS6c5.test.js` spends about **4.5 seconds** in a 24-run access fuzz
   test with many nested DOM assertions. Preserve the privilege-boundary
   property, but assess fewer deterministic cases in the default lane and a
   larger seeded fuzz run in a slow/property lane.

3. `dropboxService.retry.test.js` spends about **4.2 seconds** proving retry
   exhaustion and another **1.2 seconds** proving recovery. The implementation
   calls a real `_sleep`. Prefer an injectable sleeper/backoff policy or modern
   fake timers; do not remove retry-count and `Retry-After` coverage.

4. `caseId.test.js` spends about **3.3 seconds** generating 20,000 identifiers
   and performing per-character Jest assertions. The statistical intent is
   reasonable, but 160,000 individual `expect` calls are expensive. Aggregate
   the shape failures and distribution counts, then assert the aggregate. Also
   re-evaluate the necessary sample size mathematically.

5. `phoneSPH.pane.test.js` contains many fixed waits from 20 ms through 900 ms,
   including deliberate room for a loaded machine. This is a major runtime and
   flake source. Drive fake timers, expose a debounce flush hook, or wait for a
   semantic event/DOM condition instead of sleeping.

6. `formRender.x6card.test.js` and related form-render suites wait for the real
   approximately 300 ms auto-advance timer. Make the scheduler controllable or
   use fake timers in the harness.

7. `mascotSkins.test.js` intentionally runs animation behavior against wall
   time. Its own header records that animation once dominated the entire
   suite, and one test remains quarantined. It needs a deterministic clock or
   a separate animation lane, not additional generous sleeps.

These changes alone could remove tens of worker-seconds without deleting
behavioral coverage.

## The two supplied failures

Both originally failing suites passed together in isolation: 106/106 tests in
1.75 seconds. Both also passed in the clean four-worker full run.

### `tests/wsurlS2.test.js`

The production operation queues `history.replaceState` with `queueMicrotask`,
but the harness's `tick()` awaits `window.setTimeout(..., 0)`. The file creates
about 21 jsdom shells and does not visibly register the same explicit DOM-close
cleanup used by several newer pane suites.

Suggested investigation:

- await the actual microtask boundary (`await Promise.resolve()` or a helper
  tied to the operation) rather than a timer;
- ensure every created jsdom window is closed after each test;
- avoid merely raising the five-second Jest timeout; and
- confirm that the timeout is not masking an open handle or cross-test leak.

The evidence points to harness/load sensitivity, not a demonstrated product
defect.

### `tests/commsSummaryGround.test.js`

The test asserts that 100,000 repeated phrases complete in under exactly 1,000
ms. In the supplied loaded run it took 1,657 ms. It passed in isolation.

`contentWords` is asymptotically linear because its filler lists are fixed, but
it still normalizes/splits a large string and performs `find/every/includes`
work for every token. Suggested investigation:

- keep a large-input correctness/regression test;
- move a strict wall-clock benchmark to a performance lane;
- precompute a `Set` for filler words;
- index phrases by first token or use a small trie; and
- benchmark multiple samples with warmup if an actual performance budget is
  important.

Changing `<1000` to `<2000` in the normal suite would only move the flake
boundary.

## Skipped suites and what the number means

There are 41 directly conditional suite files:

- 37 MySQL suites gated on `YC_TEST_MYSQL_URL`;
- 3 Chromium/PDF suites gated on `PUPPETEER_EXECUTABLE_PATH`; and
- 1 Dovecot suite gated on `YC_TEST_IMAP_HOST`.

The observed result had 38 wholly skipped suites. The likely explanation is
that the three Chromium/PDF suites were enabled while the 37 MySQL suites and
the Dovecot suite were not. Reverify the environment rather than assuming.

There is also one explicit quarantined mascot test and a conditionally selected
Zoho-provider test, contributing to the 587 skipped individual tests.

`describe.skip` does not keep a file out of Jest discovery. Jest still loads
and collects it, and top-level code still executes. Separate configurations or
Jest projects would make the missing dependency explicit and avoid unnecessary
normal-run collection work.

Most importantly, `.github/workflows/node.js.yml` runs ordinary `npm test` and
does not provision MySQL or Dovecot. Unless another unreviewed gate runs them,
those suites are evidence available on demand, not part of the routine CI
guarantee. Documentation should say which system actually runs each lane and
how often.

## Feature-family audit: where to investigate consolidation

The following are **audit queues, not deletion lists**.

### 1. Mailbox and Comms UI

Approximate mailbox family alone:

- 31 suite files;
- 12,194 lines;
- about 630 statically found tests.

Many pane suites independently load `public/comms.html`, DOMPurify,
`mailRender.js`, `mailboxColor.js`, construct jsdom, install similar shell
stubs, and sleep for UI settlement. Examples include:

- `mailboxS2.pane.test.js`;
- `phoneSPH.pane.test.js`;
- `commsArchive.s4.pane.test.js`;
- `commsNoTranscribe.pane.test.js`;
- `commsAdminTools.pane.test.js`;
- `mailboxS2P.pane.test.js`; and
- `mailboxS3.pane.test.js`.

Recommended investigation:

- extract one maintained Comms-pane harness;
- separate email, phone, archive and admin scenarios while sharing boot and
  settlement primitives;
- replace fixed sleeps with observable conditions/fake timers;
- identify assertions repeated in several pane suites because later slices
  copied the earlier harness;
- retain hostile-content/XSS, sandbox/CSP, authorization, mailbox-grant,
  send/retry and data-loss coverage;
- leave one real-browser security proof in the browser lane rather than
  duplicating every logical assertion there.

This area is security-sensitive. Optimize and deduplicate before pruning.

### 2. Launcher and UI configuration

Approximate launcher family:

- 16 suite files;
- 9,297 lines;
- about 396 statically found tests.

`public/js/featureRegistry.js` is read by at least 21 suite files,
`public/js/ycIcon.js` by at least 17, and `public/js/ycLayoutEditor.js` by at
least 10. The family includes sequential names from `launcherS31` through
`launcherS6c5editor` plus UI-config suites from S3 through S6.

Recommended investigation:

- construct an invariant matrix: registry resolution, access/denial, surface
  placement, editor mutation, persistence, page/panel routing and icons;
- mark the single authoritative layer for each invariant;
- consolidate copied launcher/bootstrap harnesses;
- fold superseded slice assertions into end-state tests where the old state is
  no longer reachable;
- keep strict SU/staff/firm/user access boundaries and randomized access
  checks, potentially moving the larger fuzz sample out of the quick lane;
- avoid testing the same registry inventory independently in every slice.

Because much of this landed recently, filenames alone are especially poor
evidence for removal. Compare assertions and mutants, not age.

### 3. Form renderer and form builder

The renderer and builder have sequential `phaseA/B/C`, `slice2`, `slice25A`,
`slice25B`, `slice26`, D2/D4 and X6 suites. At least 16 suites read the same
`yc-forms.js` and/or `forms/render.html`; at least 12 read
`formTemplateService.js`.

Recommended investigation:

- inventory behavior by schema validation, rendering, conditional display,
  navigation, collection/submission, external mode and security;
- identify phase/slice assertions now fully covered by later end-state flows;
- replace real auto-advance waits with controlled time;
- share one resource loader and render harness;
- preserve hostile-input escaping, signature/schema compatibility,
  conditional-field correctness, external-form isolation and submission
  parity.

This may be the best pilot family for evidence-based pruning because its names
clearly record implementation phases and it has a definable behavior matrix.
Claude should verify that judgment.

### 4. Custom fields

Six sequential suites (`s2` through `s6`) total about 5,573 lines and 421
statically found tests. Determine which assertions describe historical
intermediate shapes versus the currently shipped schema and behavior.

Preserve field validation, permissions, server/UI projection, stored-data
compatibility and migration regression tests. Consolidate repeated case/contact
form boots and remove only assertions made redundant by a later authoritative
layer.

### 5. Workspace URL

The S0–S5ca files cover injection fixes, file links, row rendering, pane state,
main-tab state and current launcher integration. Security regressions in S0
should stay. Later routing/state files share source extraction and shell
harnesses and are candidates for one maintained harness plus smaller scenario
tables.

Do not collapse distinct XSS regression tests merely because they share a URL
feature prefix.

### 6. Sync-bus UI consumers

`caseUi.sync`, `contactUi.sync`, `pipelineBoardUi.sync`, `calendarUi.sync`,
`documentsUi.syncPanel` and related suites boot real pages with a shared
conceptual BroadcastChannel/apiSend harness. Several headers explicitly say
they copied a sibling's pattern.

Extract common scheduling, BroadcastChannel, visibility and teardown
infrastructure. Then keep one generic ordering proof plus consumer-specific
effects, instead of independently re-proving the whole bus model in every
consumer.

### 7. Large service suites

Examples include `documentSyncService`, `documentService`, `caseEventService`,
`pipelineService`, `esignSend`, `esignTemplates`, `requirementService` and
`esignService`, many with 80–160 tests in one file.

Large size alone is not a pruning reason. Audit them for large input matrices
that restate identical validation branches, repeated scripted-DB scaffolding,
and coverage at both helper and public-service layers. Prefer parameterized
tables and shared fixture builders where failure messages remain clear.

## Repeated infrastructure worth centralizing

Static indicators found:

- 124 suite files define a `ROOT` path;
- 76 define a `makeDb` helper;
- 40 define a `boot` function;
- 12 define `fnSrc` source extraction;
- 25 define an embedded `DOM` or `HTML` fixture marker;
- 34 jsdom files did not visibly contain an `afterEach` or `afterAll` hook;
- only four suite files use Jest fake timers despite 100 using Promise-based
  timers.

Do not create one enormous magical test helper. Extract small, explicit
primitives:

- jsdom ownership and guaranteed `window.close()`;
- semantic UI settlement and controllable scheduling;
- local server lifecycle using `listen(0)` and guaranteed close;
- common shell/apiSend stubs;
- source-function extraction, while production code is gradually moved to
  importable modules; and
- scripted database fixtures/guards.

Shared infrastructure reduces copy drift, but over-general helpers can hide
test intent. Keep domain-specific fixture data close to the suite.

## Suggested target execution model

This is a proposal, not a required design.

### `test:quick`

Purpose: frequent local feedback.

Include deterministic pure/unit, security-policy and cheap service tests.
Exclude real engines, external infrastructure, animation, strict performance
benchmarks and the heaviest full-page jsdom suites. Establish a measured target
such as 20–30 seconds only after classifying the actual contents.

### `test:ui`

Purpose: deterministic jsdom and source/HTML integration.

Use controlled clocks, strict teardown and a measured worker cap. It may be
run by domain during development and completely in CI.

### `test:full`

Purpose: all deterministic, self-contained checks.

This should be the merge/CI correctness gate until evidence supports a safer
split. Do not silently redefine `npm test` to a tiny subset while CI continues
to call it.

### `test:integration`

Purpose: MySQL, Chromium/PDF, Dovecot and other provisioned real-engine tests.

Split by dependency if necessary. Run against throwaway resources, serially
where suites share destructive state, with a documented owner and cadence.
Report “not configured” separately from “passed.”

### `test:perf` / `test:stress`

Purpose: strict performance budgets, larger fuzz samples, statistical checks
and animation stress. Use warmup/repetition and record measurements. A noisy
developer laptop wall-clock threshold should not be a universal correctness
gate.

Jest projects, separate config files, or explicit directory/file conventions
could implement this. Choose the simplest mechanism that makes membership
obvious. Plain `--findRelatedTests` is not sufficient here: many suites read
production files as text, so Jest does not see those as module dependencies.

## Suggested order of work

### Phase 0: reverify and write the map

- Re-run default and capped-worker profiles several times.
- Capture per-suite/per-test duration, peak memory and flakes.
- Record which gated dependencies are present.
- Build a checked-in or generated classification manifest with an owner,
  purpose and lane for each suite.
- Decide measurable targets before refactoring.

### Phase 1: remove accidental waiting without pruning

Start with high-certainty changes:

- shorten the trigger VM timeout only in its test environment;
- control Dropbox retry sleeps;
- aggregate the case-ID statistical assertions;
- use fake/control timers for phone search and form auto-advance;
- give wsurl a microtask-aware settlement helper and jsdom cleanup;
- move the comms wall-clock performance assertion out of the normal lane;
- finish the deterministic mascot clock work already noted in the repo.

Run each changed suite repeatedly and the full deterministic suite before and
after. Preserve assertions and mutation/regression intent.

### Phase 2: introduce lanes and truthful scripts

- Add explicit package scripts/configs.
- Keep the existing full deterministic CI gate until the new lanes are proven.
- Make external-suite skips disappear from ordinary output by excluding those
  files from ordinary discovery, not by pretending they passed.
- Update `CLAUDE.md`; its “well under a minute” statement is currently stale.
- Document exactly which CI/scheduled job runs each real-engine lane.

### Phase 3: consolidate one family

Choose one pilot, likely forms or launcher after reinspection:

1. enumerate behaviors and risks;
2. map every current assertion to that matrix;
3. identify duplicates and obsolete intermediate-state assertions;
4. build/shared-fix the harness;
5. remove or merge only covered assertions;
6. run mutants or deliberate breakages against preserved invariants; and
7. measure line count, runtime and failure clarity before and after.

Apply the proven method to mailbox/Comms, custom fields, workspace URL and sync
consumers. Do not set an arbitrary percentage-deletion target.

### Phase 4: governance

- Set a runtime/resource budget per lane.
- Require a reason for new slow/real-time tests.
- Prefer testing behavior once at the lowest reliable layer plus a small
  number of representative integration flows.
- When a later slice supersedes an earlier one, explicitly decide whether the
  earlier tests remain regression coverage or historical duplication.
- Track flaky tests as defects with owners; quarantine should be temporary and
  visible.

## What should generally be protected

Bias strongly toward retaining or replacing, not simply deleting:

- authentication and authorization boundaries;
- tenant/firm/user isolation;
- XSS, hostile HTML, sandbox/CSP and injection regressions;
- encryption, secret handling, HMAC and credential behavior;
- migration and stored-data compatibility;
- idempotency, retry, queue and duplicate-prevention invariants;
- destructive-operation guards;
- schema/route contracts whose drift causes silent data loss;
- regressions tied to a documented production incident; and
- one representative real-engine proof where mocks cannot establish the
  property.

## What should generally be challenged

Investigate consolidation, movement or removal when a test:

- locks an intermediate slice that can no longer exist;
- repeats the same invariant at several UI/service/route layers without a
  distinct failure mode;
- asserts copied implementation constants rather than public behavior;
- scans source strings for a fact already exercised behaviorally;
- waits arbitrary wall time instead of observing completion;
- runs a large fuzz/statistical/performance workload on every ordinary test
  invocation;
- reproduces a large sibling harness with small edits; or
- verifies UI copy or inventory in many places without a product requirement
  for exact wording/order.

Every deletion proposal should name the surviving test or other guard that
owns the behavior.

## Acceptance criteria for the eventual implementation

Claude should refine these after revalidation:

1. The two reported flakes are fixed at the harness/benchmark cause, not by
   blanket timeout inflation.
2. Normal test output contains no misleading mass of dependency-gated skips.
3. Each lane has an explicit command, scope, owner/cadence and runtime target.
4. CI still provides a strong deterministic gate.
5. External integration coverage has a real execution path or is honestly
   documented as manual/on-demand.
6. Peak resource use is measured and bounded.
7. The slowest suites no longer spend large amounts of time in avoidable real
   sleeps or production-duration timeout proofs.
8. At least one feature family is consolidated through an assertion-to-risk
   map, demonstrating that pruning did not reduce meaningful protection.
9. Documentation describes the actual suite, not the former “well under a
   minute” state.
10. A full before/after report gives wall time, worker-seconds, peak memory,
    suite/test counts, skips and repeated-run stability.

## Useful reproduction commands

Reverify paths and counts rather than copying their output blindly:

```bash
find tests -maxdepth 1 -type f -name '*.test.js' | wc -l
git ls-files 'tests/*.js' -z | xargs -0 wc -l | tail -1
npx jest --showConfig
npx jest --maxWorkers=4 --json --outputFile=/tmp/apigcr-jest-profile.json
```

Inspect conditional suites:

```bash
find tests -maxdepth 1 -name '*.mysql.test.js' | wc -l
rg -l 'const (maybe|d) = .*describe\.skip' tests -g '*.test.js'
```

Inspect common cost indicators:

```bash
rg -l "require\(['\"]jsdom['\"]\)|new JSDOM" tests -g '*.test.js'
rg -l '\.listen\s*\(' tests -g '*.test.js'
rg -l 'new Promise.*setTimeout|new Promise.*\.setTimeout' tests -g '*.test.js'
rg -n 'Date\.now|performance\.now|hrtime\.bigint' tests -g '*.test.js'
```

## Requested response from Claude before implementation

Please reply with:

1. which findings you independently reproduced;
2. which findings or interpretations you disagree with and why;
3. your proposed lane design and commands;
4. the first concrete low-risk speed/stability fixes;
5. the feature family you would pilot for consolidation and its
   assertion-to-risk map;
6. what you will explicitly preserve;
7. expected runtime/resource effects; and
8. a staged verification and rollback plan.

Again: this report is advisory. Reverify it, use independent judgment, and
prefer a smaller safe improvement over an unproven broad cleanup.
