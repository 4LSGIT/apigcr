# Docs Review — standing prompt (weekly, Cowork)

Run from the local apigcr clone (git history required — GitHub's API is
rate-limited from Claude egress IPs, and tarballs carry no history). Skip a
week only if the debt queue is empty AND no arcs closed.

## State
`fred/docs_review_state` in scratch holds
`{"reviewed_through":"<sha>","date":"<iso>","last_review_key":"docs/review_<date>"}`.
If missing (first run), baseline is 2026-09-14 (the compression pass).

## Procedure

0. **Drain the debt queue** — the review's primary input, filed by working
   sessions the moment they hit doc≠code:
   `SELECT k, v, updated_at FROM rw_scratch WHERE ns='docs' AND k NOT LIKE 'review_%' ORDER BY k`.
   Fix each item (or consciously defer, noting why on the item), then DELETE
   its key. Fold any remaining `ref/AI_CONTEXT.md` §0 entries whose subsystem
   section now exists.
1. **Code delta:** `git fetch && git log --oneline <reviewed_through>..origin/main --stat`;
   list new files in `ref/migrations/` since the baseline (filename dates
   make this tarball-safe if git is ever unavailable).
2. Bucket commits by subsystem; ignore test-only, pure-polish, and
   generated-file commits (`ref/database.sql`, `ref/routes.md`,
   `TRACKED_FILES.txt`).
3. Route each bucket per the CLAUDE.md living-docs table: schema facts →
   COMMENT migration; subsystem invariants → the AI_CONTEXT section (register
   density — what + invariants + pointers, never manual duplication);
   operator behavior → manual chapter (README TOC contract:
   `tests/manualReadmeCoverage.test.js` must pass); cross-cutting →
   CLAUDE.md (rare; keep it lean); deferred → plans.md. Routes/§4 drift:
   diff against freshly generated `ref/routes.md`, don't read commits.
4. **Scratch sweep** — scratch is for fast-moving state; the review keeps it
   honest: `SELECT ns, k, LENGTH(v) len, updated_at FROM rw_scratch ORDER BY ns, updated_at`.
   Flag: arc-state keys for arcs that have closed (their durable conclusions
   should have graduated to docs — verify, then the key is deletable); debt
   items deferred two reviews running; keys untouched >30 days; anything
   whose purpose you can't identify. **Propose deletions in the report —
   delete only on Fred's approval in-session** (a stale-looking key may back
   a paused arc).
5. **ref/ hygiene:** any `ref/` root file belonging to a closed arc moves to
   `ref/archive/` or `ref/migrations/` — check
   `grep -rn "ref/<name>" tests/ scripts/` first; pinned files stay.
6. Propose diffs; Fred approves; commit.
7. Update the CURRENCY block atop `ref/AI_CONTEXT.md`: reviewed-through SHA,
   resolved gaps cleared, conscious deferrals listed.
8. **Record + report** (see Outputs), then update `fred/docs_review_state`.

## Outputs

- **Report to Fred — only when there's something actionable.** Format, short:
  *Fixed* (what changed, one line each) · *Needs your call* (proposed diffs
  or deletions awaiting approval) · *Deferred* (with the debt key carrying
  the reason) · *Queue after* (item count) · *Scratch flags*. If the queue
  was empty, the code delta needed nothing, and scratch is clean: say
  "clean" in one line — no report.
- **Scratch record, every run:** `PUT /api/scratch/docs/review_<YYYYMMDD>`
  with a short JSON summary:
  `{"reviewed_through":…,"fixed":N,"deferred":N,"queue_after":N,"scratch_flags":N,"notes":"one line"}`.
  Keep the last ~8 `review_*` keys; propose pruning older ones in the sweep.

## Rules

- Propose, don't silently rewrite: AI_CONTEXT wording is load-bearing for
  worker sessions; large rewrites need Fred's eyes.
- Docs describe what code DOES. When a commit and a doc conflict, read the
  code, then fix the doc.
- Additions match register density — if a section is growing back toward
  its pre-compression size, that's a signal to push detail down into the
  manual or schema comments, not a reason for a longer section.
- Timebox: if the delta is huge, do queue + schema/routes + currency header
  first; park prose sections as filed debt rather than half-updating them.