# Docs Review — standing prompt (weekly, Cowork)

Run from the local apigcr clone (git history required — GitHub's API is
rate-limited from Claude egress IPs, and tarballs carry no history).

## State
Scratch key `ns=fred, k=docs_review_state` holds
`{"reviewed_through": "<sha>", "date": "<iso>"}`.
If missing (first run), baseline is 2026-08-25 — the catch-up review covers
the entire stale window listed in AI_CONTEXT's currency header.

## Procedure
0. **Drain the debt queue first** — it is the review's primary input, filed
   by working sessions at the moment they hit doc≠code:
   `SELECT k, v, updated_at FROM rw_scratch WHERE ns='docs' ORDER BY k`.
   Fix each item (or consciously defer it in place), then DELETE its key.
   Also fold any remaining `ref/AI_CONTEXT.md` §0 delta entries into their
   home sections and delete the entry.
1. `git fetch && git log --oneline <reviewed_through>..origin/main --stat`
   (first run: `--since=2026-08-25`). Also list new files in
   `ref/migrations/` since the baseline — filename dates make this
   tarball-safe if git is ever unavailable.
2. Bucket the commits by subsystem. Ignore pure-frontend polish, test-only,
   and generated-file commits (`ref/database.sql`, `ref/routes.md`,
   `TRACKED_FILES.txt`).
3. For each bucket, decide what it touches:
   - `ref/AI_CONTEXT.md` — schema (§2), routes (§4), internal functions (§5),
     engine semantics, new subsystems. Routes/§4 drift: diff against the
     freshly generated `ref/routes.md` rather than reading commits.
   - `manual/` — operator-visible behavior. Respect the README-TOC contract
     (`tests/manualReadmeCoverage.test.js` must pass after edits).
   - `CLAUDE.md` — only if a new invariant/landmine emerged (rare; keep it lean).
4. Propose diffs; Fred approves; commit.
5. Update the CURRENCY block at the top of `ref/AI_CONTEXT.md`:
   set reviewed-through SHA, clear resolved gap lines, add any consciously
   deferred gaps.
6. `PUT /api/scratch/fred/docs_review_state` with the new SHA + date.
7. Arc hygiene while in there: any `ref/` root file belonging to a closed arc
   moves to `ref/archive/` or `ref/migrations/` (check
   `grep -rn "ref/<name>" tests/ scripts/` first — pinned files stay).

## Rules
- Propose, don't silently rewrite: AI_CONTEXT wording is load-bearing for
  worker sessions; large rewrites need Fred's eyes.
- Docs describe what code DOES. When a commit and existing doc conflict,
  read the code, then fix the doc.
- Timebox: if the delta is huge, do schema + routes + currency header first;
  park prose sections as listed gaps rather than half-updating them.
