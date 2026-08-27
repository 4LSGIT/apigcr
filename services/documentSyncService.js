// services/documentSyncService.js
//
/**
 * Document Sync Engine — Dropbox → `documents` (Documents S2)
 * services/documentSyncService.js
 *
 * Pool-first, like every other service here: `db` is the first argument and
 * nothing in this file knows about Express. It sits between
 * services/dropboxService.js (the provider) and services/documentService.js
 * (the rows), and it owns exactly one thing: keeping the registry filled.
 *
 * ── THE SHAPE OF THE PROBLEM ──────────────────────────────────────────────
 * ~150,000 files across 7 roots, and no long-running process anywhere to walk
 * them. Recurring work in this app is a `scheduled_jobs` row executed by the
 * routes/process_jobs.js poller, so a "job execution" is a slice of ONE poll
 * tick — bounded by that tick, killable by a Cloud Run reap, and re-entered
 * by the next tick with no memory of the last.
 *
 * So the backfill is not a batch job that runs for an hour. It is a sequence
 * of page-budgeted increments that each persist their cursor and then stop.
 * Eighty-odd pages of 2,000 entries become eighty-odd resumptions, and the
 * only state carried between them is `document_sync_roots.sync_cursor`.
 *
 * ── ONE CURSOR, TWO QUESTIONS — DO NOT CONFLATE THEM ──────────────────────
 * Dropbox's list_folder cursor does double duty: paging THROUGH the initial
 * listing, and then delta-ing FROM it. S2 originally derived the emission
 * mode from cursor PRESENCE alone, and that was WRONG in a way that took
 * production to expose:
 *
 *     a backfill stopped by the page budget PERSISTS A CURSOR.
 *
 * On the next tick that cursor made the root look "already backfilled", so
 * the engine flipped to per-row writes with emissions ON — while still
 * paging through the INITIAL listing, with ~100,000 never-before-seen files
 * left to walk. Measured 2026-08-26: root 1 did 25 pages / 12,332 files in
 * 37s in backfill mode, then 7 pages in 495s in incremental mode (~47x
 * slower per page) and began emitting document.created for files that had
 * been sitting in Dropbox for years. Root 3 (Closed Cases) was ~50,000 files
 * away from doing the same.
 *
 * The two questions are separate and are now answered separately:
 *
 *   WHICH API CALL?      cursor presence.
 *                        NULL → files/list_folder, else → .../continue.
 *   WHICH WRITE POLICY?  backfill_done.
 *                        0 → bulk writes, emissions OFF.
 *                        1 → per-row writes, emissions ON.
 *
 * `backfill_done` flips exactly once per root: when a page comes back with
 * has_more = false while still in backfill. That is the only moment the
 * initial listing is provably complete — and it is NOT the same moment a
 * cursor first exists.
 *
 * The 409-`reset` recovery still works, and still for the original reason:
 * a reset clears the cursor AND resets backfill_done to 0, so the forced
 * re-walk of the whole subtree runs emissions-off. Both halves must move
 * together; resetting only the cursor would re-introduce exactly the bug
 * above, one root at a time.
 *
 * ── WHY THE BACKFILL EMITS NOTHING ────────────────────────────────────────
 * A file that has been sitting in Dropbox since 2019 is not news. Emitting
 * document.created for it would run the trigger engine 150,000 times, write
 * 150,000 trigger_executions rows, and fire every rule any staffer ever
 * wrote against document.created — retroactively, over the entire history of
 * the firm. documentService.upsertFromEntry's `{ emit: false }` option and
 * the bulk paths exist for this one reason.
 *
 * ── ATTRIBUTION ───────────────────────────────────────────────────────────
 * A document acquires an owner through document_links, and the only signal
 * available at sync time is the PATH: a file living under a case's Dropbox
 * folder belongs to that case. case_folder_cache maps case → folder path (one
 * shared-link resolution per case, refreshed on its own schedule), and each
 * file is matched by walking UP its own directory chain — see _matchCase.
 *
 * Two attribution passes, on purpose:
 *   inline (during sync)  — catches everything whose case folder is already
 *                           cached. On the incremental path this emits
 *                           document.linked, which is the event that gives a
 *                           document a case_id.
 *   attributeUnlinked()   — the reconcile sweep, SILENT ALWAYS, for files
 *                           ingested before their case folder was cached.
 *
 * ── MACHINE LINKS TRACK THE FILESYSTEM; HUMAN LINKS EXPRESS INTENT (S3.1) ─
 * Every link this engine writes — backfill, incremental, sweep — carries
 * `relation = 'path'` and a NULL created_by. That pair is the discriminator:
 * the engine has no user, and the UI's links always carry one from the JWT.
 *
 * It buys ONE behaviour, and the behaviour is the point: when a file's
 * path_lower changes and its case-folder match changes with it, the engine
 * RETRACTS its own now-false path-link and writes the true one. It never
 * touches a link a person made.
 *
 * Without that, staff moving a file from case A's folder to case B's leaves A
 * asserting ownership forever — and S3.1's related-documents view amplifies
 * that: the stale link surfaces the document on case A AND on every contact
 * related to case A, badged, indistinguishable from a correct one. A wrong
 * answer delivered confidently is worse than no answer, which is why the
 * hygiene rule ships in the same slice as the view that would expose it.
 *
 * Reconciliation runs on the INCREMENTAL path only. The backfill is a first
 * walk — there is nothing stale to retract — and the sweep only ADDS where no
 * path-link exists, deliberately declining to re-litigate a move it would be
 * judging from a slower, staler cache than the delta feed had.
 *
 * ⚠️ EVENT-SEMANTICS GAP, KNOWN AND ACCEPTED: document.linked fires from the
 * sync ONLY when attribution succeeds AT INGEST TIME. Stragglers linked by
 * the sweep are linked silently. The first sweep after the backfill links
 * ~100k+ rows in one pass; emitting there would be precisely the storm that
 * emit:false exists to prevent. A rule that must see every case attribution
 * cannot be written against document.linked alone — it needs a periodic
 * reconcile of its own. This is a real limitation, not an oversight.
 *
 * ── CONCURRENCY ───────────────────────────────────────────────────────────
 * Poll ticks overlap (a slow tick is still running when the next fires), and
 * `documents_sync` is also callable by hand. syncRoot therefore CLAIMS a root
 * with a conditional UPDATE before touching it, and refreshes the claim after
 * every page. Two runners cannot process one root; they can process DIFFERENT
 * roots simultaneously, which is harmless.
 *
 * NOTE on affectedRows: this pool runs mysql2's default CLIENT_FOUND_ROWS, so
 * affectedRows on an UPDATE is rows MATCHED, not rows CHANGED. For the claim
 * that is exactly the semantic wanted — "did my WHERE find a claimable row?"
 * — which is why claim-by-UPDATE is sound here while the same field is
 * useless for detecting upsert duplicates (see documentService.link).
 *
 * Exports:
 *   refreshCaseFolderCache(db, opts) -> { resolved, failed, out_of_root, ... }
 *   syncRoot(db, root, opts)         -> per-root result
 *   syncAll(db, opts)                -> { roots: [...], ... }
 *   attributeUnlinked(db, opts)      -> { scanned, linked }
 *   attributionReport(db, opts)      -> zero-attribution / residue diagnostic
 *
 * S3.2 — the ops surface behind public/documents.html's Sync panel. Root
 * management lives here because this file already owns every write to
 * document_sync_roots, and because the routes layer owns no SQL:
 *   listRoots(db) / getRoot(db, id) -> panel-safe rows (NO cursor)
 *   getRootRaw(db, id)              -> the full row, for syncRoot
 *   addRoot(db, {path, note}, opts) -> { root, warning }
 *   setRootEnabled(db, id, enabled) -> row|null    THE ONLY MUTABLE FIELD
 *   isSyncEnabled(db)               -> the fail-closed kill switch, one reader
 *   latestJobReports(db, names)     -> what the recurring reports last said
 * There is NO deleteRoot, on purpose — see that section's header.
 */

'use strict';

const dropbox   = require('./dropboxService');
const documents = require('./documentService');

/** documents.source for everything this engine writes. */
const SOURCE = 'dropbox';

/**
 * A root claim older than this is considered abandoned and may be taken over.
 *
 * Deliberately EQUAL to process_jobs.js's RECOVERY_WINDOW_MIN, and deliberately
 * paired with a wall-clock bound well under both (see DEFAULT_MAX_RUNTIME_MS).
 * The stuck-job recovery flips a job still 'running' after 15 minutes back to
 * 'pending', spawning a second concurrent run; if a claim could also expire at
 * exactly 15 minutes the two would race for the same root. The runtime bound
 * makes that unreachable: a run always releases its claim, or dies, minutes
 * before either timer fires.
 */
const CLAIM_STALE_MIN = 15;

/** Dropbox's per-page ceiling for files/list_folder. */
const PAGE_LIMIT = 2000;

/** Pages per syncAll invocation, shared across roots. ~80 pages = whole estate. */
const DEFAULT_MAX_PAGES = 25;

/**
 * Wall-clock bound for one sync invocation. 8 minutes, matching
 * emit_stage_aged's reasoning: the page budget bounds API CALLS, not TIME, and
 * a slow Dropbox turns 25 pages into an unbounded run. Stopping here leaves the
 * cursor persisted at the last completed page, so the next tick resumes exactly
 * there — an exhausted budget and an exhausted clock have identical semantics.
 */
const DEFAULT_MAX_RUNTIME_MS = 8 * 60 * 1000;

/**
 * Wall-clock bound for ONE refreshCaseFolderCache run.
 *
 * Each case is a sequential sharing/get_shared_link_metadata call. The S2
 * docblock estimated ~150ms; production measured closer to 1s, making the
 * default limit of 300 a FIVE-MINUTE call — held open inside a poll tick, and
 * inside the HTTP request when hand-run through /workflows/test-step.
 *
 * A COUNT bound cannot fix that, because the thing that varies is latency, not
 * cardinality. 4 minutes keeps one run comfortably inside process_jobs'
 * 15-minute stuck-job recovery no matter how slow Dropbox gets. Stopping early
 * loses nothing: the scan is oldest-resolved-first, so the next run picks up
 * exactly the cases this one did not reach.
 */
const DEFAULT_CACHE_RUNTIME_MS = 4 * 60 * 1000;

/** case_folder_cache.resolve_error is VARCHAR(255); no STRICT_TRANS_TABLES here. */
const RESOLVE_ERROR_MAX = 255;

/** Cap on the out_of_root / failures report lists so job_results stays readable. */
const REPORT_CAP = 200;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function _clamp(v, n) {
  if (v == null) return null;
  const s = String(v);
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

function _int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * Longest-prefix case match by walking UP the file's own directory chain.
 *
 * ── WHY NOT startsWith OVER THE CACHE ─────────────────────────────────────
 * Two reasons. Cost: scanning ~1,000 cached folder paths per file, 150,000
 * times, is 150 million string comparisons. Correctness: a bare
 * `path.startsWith(folder)` matches "/x/  case ab/f.pdf" against the case
 * folder "/x/  case a" — a real shape here, where folders are named
 * "  Smith, John - 12345 -  Chapter 7" and a second case for the same client
 * gets a longer name with the same prefix. Files would be filed against the
 * wrong client's case. Silently.
 *
 * Walking up segments cannot make that mistake: it only ever compares WHOLE
 * paths ending at a real '/' boundary. And because it walks from the deepest
 * directory outward, the FIRST hit is by construction the longest match — a
 * file in a subfolder of a case folder that itself sits under another cached
 * folder attributes to the innermost one.
 *
 * @param {Map<string, object>} cacheByPath  path_lower → { case_id, ... }
 * @param {string} pathLower                 the FILE's path_lower
 * @returns {object|null}
 */
function _matchCase(cacheByPath, pathLower) {
  if (!pathLower || !cacheByPath.size) return null;
  const p = String(pathLower);
  let i = p.lastIndexOf('/');
  while (i > 0) {
    const hit = cacheByPath.get(p.slice(0, i));
    if (hit) return hit;
    i = p.lastIndexOf('/', i - 1);
  }
  return null;
}

/** Is `pathLower` at or under `rootLower`? Segment-boundary safe (see _matchCase). */
function _underRoot(pathLower, rootLower) {
  if (!pathLower || !rootLower) return false;
  return pathLower === rootLower || pathLower.startsWith(rootLower + '/');
}

/**
 * Load the whole case-folder cache into memory, ONCE per sync call.
 *
 * ~1,000 rows. Re-querying per file would be 150,000 round trips; per page it
 * would still be 80. Rows with a NULL path_lower (resolution failed, or never
 * ran) are excluded — they can match nothing, and keeping them would let a
 * `null` key swallow lookups.
 */
async function _loadCaseFolderCache(db) {
  const [rows] = await db.query(
    `SELECT case_id, folder_external_id, path_lower
       FROM case_folder_cache
      WHERE path_lower IS NOT NULL AND path_lower <> ''`,
  );
  const byPath  = new Map();
  const byExtId = new Map();
  for (const r of rows) {
    byPath.set(String(r.path_lower), { case_id: r.case_id, path_lower: r.path_lower });
    if (r.folder_external_id) byExtId.set(String(r.folder_external_id), r);
  }
  return { byPath, byExtId, size: rows.length };
}

/** Enabled roots, path lowercased for prefix tests. */
async function _loadEnabledRootPaths(db) {
  const [rows] = await db.query(
    'SELECT id, path FROM document_sync_roots WHERE enabled = 1',
  );
  return rows.map(r => String(r.path).toLowerCase());
}

/** Fire-and-forget alert; never throws, never blocks the sync. */
function _alert(db, opts) {
  try {
    const { alert } = require('../lib/alerting'); // lazy require (convention)
    return Promise.resolve(alert(db, opts)).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────
// refreshCaseFolderCache
// ─────────────────────────────────────────────────────────────

/**
 * Resolve case → Dropbox folder path, oldest-first, in bounded batches.
 *
 * `cases.case_dropbox` holds a SHARED LINK, not a path — that is the whole
 * point of the shared-link-as-handle pattern (staff move and rename case
 * folders constantly; the link keeps resolving). Resolving one costs an API
 * call, and 1,009 API calls is not something to do per sync tick, so the
 * results are cached in case_folder_cache and refreshed on their own slower
 * schedule.
 *
 * Oldest-first with never-resolved counting as oldest, so a fresh install
 * fills the cache over successive runs and a steady state re-checks the
 * staleset. Sequential by design: the pool holds 10 connections and Dropbox
 * rate-limits per app — 300 sequential calls at ~150ms is ~45s, comfortably
 * inside a tick and inside the runtime bound.
 *
 * A FAILURE stores resolve_error and LEAVES THE PRIOR PATHS INTACT. A revoked
 * or rate-limited link must not blank a path that was working yesterday and
 * silently unfile every future document for that case.
 *
 * `out_of_root` is the "nothing is silently unwatched" report: cases whose
 * freshly-resolved folder sits under NO enabled sync root. Those cases have a
 * Dropbox folder the engine will never walk, so their documents will never
 * register — a data problem no amount of correct code detects on its own.
 * It is returned, not persisted: this runs as an internal function and
 * job_results IS the report surface.
 *
 * BOUNDED BY WALL CLOCK as well as by count — see DEFAULT_CACHE_RUNTIME_MS.
 * Hitting the bound is a normal outcome, reported as timed_out, not an error.
 *
 * @param {object} db
 * @param {object} [opts] — { limit=300, maxRuntimeMs=240000, credentialId? }
 * @returns {Promise<{resolved:number, failed:number, out_of_root:string[], ...}>}
 */
async function refreshCaseFolderCache(db, opts = {}) {
  const limit = Math.min(_int(opts.limit, 300), 2000);
  const credentialId = opts.credentialId ?? null;
  const startedAt = Date.now();
  const deadline = startedAt + _int(opts.maxRuntimeMs, DEFAULT_CACHE_RUNTIME_MS);

  // ── TARGETED MODE (S3.3) ────────────────────────────────────────────────
  // `caseIds` names EXACTLY which cases to resolve, and when it is present the
  // staleness ordering and the count limit are both irrelevant — the caller is
  // not sampling the stale set, it is refreshing one case it just changed.
  //
  // It exists because the sweep laps the table in ~5 hours and staff open the
  // case page SECONDS after confirming a re-link. Waiting for the recurring
  // job would mean the confirm appears to have done nothing.
  //
  // The no-arg path below is byte-for-byte what it always was. Everything
  // after this branch — the loop, the Dropbox call, the upsert, the failure
  // handling, out_of_root — is shared, so the two modes cannot drift.
  const caseIds = Array.isArray(opts.caseIds)
    ? [...new Set(opts.caseIds.map(v => String(v)).filter(Boolean))]
    : null;

  let cases;
  if (caseIds) {
    if (!caseIds.length) {
      return {
        resolved: 0, failed: 0, out_of_root: [], scanned: 0, candidates: 0,
        limit, targeted: true, timed_out: false, elapsed_ms: Date.now() - startedAt,
      };
    }
    [cases] = await db.query(
      `SELECT c.case_id, c.case_dropbox
         FROM cases c
        WHERE c.case_id IN (?)
          AND c.case_dropbox IS NOT NULL AND c.case_dropbox <> ''`,
      [caseIds],
    );
  } else {
    // Oldest-first; rows absent from the cache sort ahead of every resolved one.
    [cases] = await db.query(
      `SELECT c.case_id, c.case_dropbox
         FROM cases c
         LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
        WHERE c.case_dropbox IS NOT NULL AND c.case_dropbox <> ''
        ORDER BY (f.resolved_at IS NULL) DESC, f.resolved_at ASC
        LIMIT ${limit}`,
    );
  }

  const rootPaths = await _loadEnabledRootPaths(db);

  let resolved = 0;
  let failed   = 0;
  let timedOut = false;
  const outOfRoot = [];
  const failures  = [];

  for (const c of cases) {
    // Checked BEFORE the API call, so the bound is never overshot by a full
    // Dropbox round trip. Oldest-first ordering means the unreached tail is
    // exactly what the next run picks up.
    if (Date.now() >= deadline) { timedOut = true; break; }

    let meta = null;
    try {
      meta = await dropbox.getSharedLinkMetadata(db, {
        url: c.case_dropbox,
        ...(credentialId != null ? { credentialId } : {}),
      });
    } catch (err) {
      failed++;
      if (failures.length < REPORT_CAP) {
        failures.push({ case_id: c.case_id, error: _clamp(err.message, 160) });
      }
      // Prior paths survive — only the error field and the timestamp move.
      await db.query(
        `INSERT INTO case_folder_cache (case_id, resolve_error, resolved_at)
         VALUES (?, ?, NOW()) AS new
         ON DUPLICATE KEY UPDATE
           resolve_error = new.resolve_error,
           resolved_at   = NOW()`,
        [c.case_id, _clamp(err.message, RESOLVE_ERROR_MAX)],
      );
      continue;
    }

    const pathLower = meta && meta.path_lower ? String(meta.path_lower) : null;
    if (!pathLower) {
      // A link that resolves but exposes no path (content outside this
      // account, or a link to a file rather than a folder). Same treatment
      // as a hard failure: recorded, prior paths untouched.
      failed++;
      if (failures.length < REPORT_CAP) {
        failures.push({ case_id: c.case_id, error: 'shared link metadata has no path_lower' });
      }
      await db.query(
        `INSERT INTO case_folder_cache (case_id, resolve_error, resolved_at)
         VALUES (?, ?, NOW()) AS new
         ON DUPLICATE KEY UPDATE
           resolve_error = new.resolve_error,
           resolved_at   = NOW()`,
        [c.case_id, 'shared link metadata has no path_lower'],
      );
      continue;
    }

    await db.query(
      `INSERT INTO case_folder_cache
         (case_id, folder_external_id, path_lower, path_display, resolve_error, resolved_at)
       VALUES (?, ?, ?, ?, NULL, NOW()) AS new
       ON DUPLICATE KEY UPDATE
         folder_external_id = new.folder_external_id,
         path_lower         = new.path_lower,
         path_display       = new.path_display,
         resolve_error      = NULL,
         resolved_at        = NOW()`,
      [
        c.case_id,
        meta.id ? _clamp(meta.id, 191) : null,
        pathLower,
        meta.path_display != null ? String(meta.path_display) : null,
      ],
    );
    resolved++;

    if (!rootPaths.some(rp => _underRoot(pathLower, rp)) && outOfRoot.length < REPORT_CAP) {
      outOfRoot.push(c.case_id);
    }
  }

  return {
    resolved,
    failed,
    out_of_root: outOfRoot,
    scanned: resolved + failed,
    candidates: cases.length,
    limit,
    ...(caseIds ? { targeted: true } : {}),
    timed_out: timedOut,
    elapsed_ms: Date.now() - startedAt,
    ...(failures.length ? { failures } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// syncRoot
// ─────────────────────────────────────────────────────────────

/**
 * Sync ONE root, cursor-resumable, bounded by pages and by wall clock.
 *
 * Mode is derived from cursor presence (see the file header). Per page, in
 * this order: register files → attribute them → heal folder moves in the
 * cache → mark deletes. Then the cursor is persisted BEFORE the next page is
 * fetched, so a crash, a budget exhaustion or a Cloud Run reap between pages
 * resumes exactly where it stopped and re-processes nothing.
 *
 * ORDER MATTERS. Files register before attribution because attribution needs
 * their row ids. Deletes go LAST so that a page containing both a re-add and
 * a delete of the same path resolves the way Dropbox ordered it.
 *
 * @param {object} db
 * @param {object} root — a document_sync_roots row { id, path, sync_cursor, ... }
 * @param {object} [opts]
 * @param {number} [opts.maxPages]       per-call page cap for THIS root
 * @param {object} [opts.budget]         shared { pages: n } counter across roots
 * @param {number} [opts.deadline]       epoch ms; stop cleanly at/after it
 * @param {object} [opts.cache]          preloaded cache from _loadCaseFolderCache
 * @param {number} [opts.credentialId]
 * @returns {Promise<object>} per-root result (mode, pages, files, linked, …)
 */
async function syncRoot(db, root, opts = {}) {
  const maxPages = _int(opts.maxPages, DEFAULT_MAX_PAGES);
  const budget   = opts.budget || null;
  const deadline = opts.deadline ?? (Date.now() + DEFAULT_MAX_RUNTIME_MS);
  const credOpt  = opts.credentialId != null ? { credentialId: opts.credentialId } : {};
  const startedAt = Date.now();

  // ── 1. Claim ────────────────────────────────────────────────────────────
  // Conditional UPDATE, not a read-then-write: the server decides the winner.
  // affectedRows here is rows MATCHED (CLIENT_FOUND_ROWS — see file header),
  // which is precisely "did my WHERE find a claimable row?".
  const [claim] = await db.query(
    `UPDATE document_sync_roots
        SET syncing_since = NOW()
      WHERE id = ?
        AND (syncing_since IS NULL OR syncing_since < NOW() - INTERVAL ? MINUTE)`,
    [root.id, CLAIM_STALE_MIN],
  );
  if (!claim.affectedRows) {
    return { root_id: root.id, path: root.path, skipped: true, reason: 'claimed_elsewhere' };
  }

  // WRITE POLICY ← backfill_done.  API CALL ← cursor presence.  These are
  // different questions; see the header for what conflating them cost.
  const backfill = !root.backfill_done;
  const mode = backfill ? 'backfill' : 'incremental';
  let cursor = root.sync_cursor || null;
  let backfillCompleted = false;

  const cache = opts.cache || await _loadCaseFolderCache(db);

  let pages = 0, files = 0, linked = 0, deletedRows = 0, folderHeals = 0;
  // Path-links retracted by move reconciliation (S3.1). Reported separately
  // from `linked` on purpose: a healthy steady state has a few of each and a
  // spike in this one alone means folders are being reorganised, which is
  // worth being able to see in job_results.
  let unlinked = 0;
  let stopReason = 'complete';

  try {
    for (;;) {
      if (pages >= maxPages)                      { stopReason = 'page_cap';  break; }
      if (budget && budget.pages <= 0)            { stopReason = 'budget';    break; }
      if (Date.now() >= deadline)                 { stopReason = 'time_cap';  break; }

      // ── 2. Fetch one page ────────────────────────────────────────────────
      let page;
      try {
        page = cursor
          ? await dropbox.listFolderContinue(db, { cursor, ...credOpt })
          : await dropbox.listFolderPage(db, {
              path: root.path, recursive: true, limit: PAGE_LIMIT, ...credOpt,
            });
      } catch (err) {
        // EMPTY ROOT, not an error. The three "Unsorted …" roots are created
        // lazily by the upload / e-sign / forms ladders and do not exist yet.
        // Treating this as a failure would park three roots in a permanent
        // error state and hide real failures behind the noise.
        if (!cursor && dropbox.isPathNotFoundError(err)) {
          // NOTE: backfill_done stays 0. The folder does not exist yet, so
          // there is no listing to have completed — and when it IS created,
          // the first real walk must run emissions-off like any other backfill.
          await db.query(
            `UPDATE document_sync_roots
                SET last_sync_at = NOW(), last_error = NULL,
                    stats = ?, syncing_since = NULL
              WHERE id = ?`,
            [JSON.stringify({ mode: 'empty_root', pages: 0, files: 0, ms: Date.now() - startedAt }), root.id],
          );
          return {
            root_id: root.id, path: root.path, mode: 'empty_root',
            pages: 0, files: 0, linked: 0, deleted: 0,
            note: 'path/not_found — folder not created yet',
            ms: Date.now() - startedAt,
          };
        }

        // CURSOR RESET. Not transient: the same cursor will never work again.
        // Clearing it drops this root back into backfill mode on the next
        // tick — emissions OFF — so the forced full re-list of up to 121,000
        // files cannot storm the trigger engine. That is the entire reason
        // mode is derived from cursor presence instead of stored.
        if (cursor && dropbox.isCursorResetError(err)) {
          // BOTH halves, in one statement. Clearing the cursor without
          // clearing backfill_done would re-list the entire subtree with
          // emissions ON — the exact bug this column exists to prevent.
          await db.query(
            `UPDATE document_sync_roots
                SET sync_cursor = NULL, backfill_done = 0,
                    last_error = ?, syncing_since = NULL
              WHERE id = ?`,
            [_clamp(`cursor reset: ${err.message}`, 1000), root.id],
          );
          await _alert(db, {
            source: 'app',
            kind: 'documents_sync_cursor_reset',
            severity: 'warning',
            group_key: `documents_sync_cursor_reset:${root.id}`,
            title: `Documents sync cursor reset for root ${root.id}`,
            message:
              `Dropbox invalidated the delta cursor for "${root.path}". The cursor has been ` +
              `cleared and the root will re-enter BACKFILL mode (emissions off) on the next ` +
              `tick, re-listing the whole subtree over successive ticks. No documents are ` +
              `lost — upserts are idempotent — but nothing new under this root emits ` +
              `document.created until the re-list completes.`,
            context: { root_id: root.id, path: root.path, error: _clamp(err.message, 300) },
          });
          return {
            root_id: root.id, path: root.path, mode, pages,
            files, linked, deleted: deletedRows,
            cursor_reset: true, ms: Date.now() - startedAt,
          };
        }

        throw err;
      }

      pages++;
      if (budget) budget.pages--;

      // ── 3. Sort the page ─────────────────────────────────────────────────
      const fileEntries    = [];
      const folderEntries  = [];
      const deletedEntries = [];
      for (const e of page.entries) {
        const tag = e && e['.tag'];
        if (tag === 'file')         fileEntries.push(e);
        else if (tag === 'folder')  folderEntries.push(e);
        else if (tag === 'deleted') deletedEntries.push(e);
        // Unknown tags are ignored rather than guessed at.
      }

      // ── 3a. Folders FIRST — NOT registered, but they can heal the cache ──
      //
      // ORDER DIVERGES FROM THE S2 SPEC (which said files → attribution →
      // folders → deletes), and a test caught why it had to. A folder entry
      // whose id matches a cached case folder means that case folder MOVED or
      // was RENAMED — Active Cases → Closed Cases at case close is routine
      // here. Dropbox re-reports the folder AND its descendants in the same
      // delta, so healing AFTER attribution matches every file in that page
      // against the folder's OLD path and misses.
      //
      // Existing documents survive either way (a link is keyed on document_id,
      // not path, and the reconcile sweep catches stragglers), so this was a
      // one-tick delay rather than data loss — but healing first costs nothing
      // and makes the page self-consistent. Folder entries can only ever
      // affect the attribution map, never a registration or a delete, so
      // moving them earlier has no other consequence.
      for (const f of folderEntries) {
        if (!f.id) continue;
        const cached = cache.byExtId.get(String(f.id));
        if (!cached) continue;
        const newLower = f.path_lower != null ? String(f.path_lower) : null;
        if (!newLower || newLower === cached.path_lower) continue;

        await db.query(
          `UPDATE case_folder_cache
              SET path_lower = ?, path_display = ?, resolve_error = NULL, resolved_at = NOW()
            WHERE case_id = ?`,
          [newLower, f.path_display != null ? String(f.path_display) : null, cached.case_id],
        );
        // Keep the in-memory map coherent for the REST of this run.
        cache.byPath.delete(cached.path_lower);
        cache.byPath.set(newLower, { case_id: cached.case_id, path_lower: newLower });
        cached.path_lower = newLower;
        folderHeals++;
      }

      // ── 3b. Files ────────────────────────────────────────────────────────
      if (fileEntries.length) {
        if (backfill) {
          await documents.bulkUpsertEntries(db, SOURCE, fileEntries);

          // Attribution needs row ids, and a multi-row INSERT hands back none.
          // Resolve ONLY the files that actually matched a case — no point
          // looking up the id of something nothing will link.
          const matched = [];
          for (const e of fileEntries) {
            const hit = _matchCase(cache.byPath, e.path_lower);
            if (hit) matched.push({ entry: e, case_id: hit.case_id });
          }
          if (matched.length) {
            const idMap = await documents.mapExternalIds(
              db, SOURCE, matched.map(m => m.entry.id),
            );
            const links = [];
            for (const m of matched) {
              const found = idMap.get(String(m.entry.id));
              if (found) {
                links.push({
                  document_id: found.id, link_type: 'case', link_id: m.case_id,
                  // S3.1: everything the ENGINE writes is a path-link, so the
                  // reconciler can later tell it from a human's link and retract
                  // it when the file moves. created_by stays null — the engine
                  // has no user, and that is the other half of the discriminator.
                  relation: documents.RELATION_PATH,
                });
              }
            }
            if (links.length) {
              await documents.bulkLink(db, links);
              linked += links.length;
            }
          }
        } else {
          // INCREMENTAL: per-entry, emissions ON. Three queries per row is
          // nothing at delta volumes, and the event is the entire point.
          for (const e of fileEntries) {
            const { row, changes } = await documents.upsertFromEntry(db, SOURCE, e, {
              emit: true, eventSource: 'system',
            });
            const hit = _matchCase(cache.byPath, e.path_lower);

            // ── MOVE RECONCILIATION (S3.1) ─────────────────────────────────
            // A file dragged from case A's folder into case B's arrives here
            // as a plain update with a new path_lower. Without this, A's link
            // survives forever and the related view surfaces the document on
            // A and every contact related to A — badged, and wrong.
            //
            // Gated on path_lower ACTUALLY having changed, which is why
            // upsertFromEntry returns its changes map (S3.1). A re-walk of an
            // unmoved file must not cost a DELETE per row.
            //
            // ONLY the engine's own path-links are in scope, and that is
            // enforced in the DELETE's WHERE rather than filtered afterwards —
            // see documentService.reconcilePathLinks.
            if (row && changes &&
                Object.prototype.hasOwnProperty.call(changes, 'path_lower')) {
              const dropped = await documents.reconcilePathLinks(
                db, row.id, hit ? hit.case_id : null,
              );
              if (dropped) unlinked += dropped;
            }

            if (hit && row) {
              // link() emits document.linked for a genuinely NEW link only —
              // idempotent and silent on a repeat, which is exactly S1's
              // contract and what makes re-processing a page safe. A move INTO
              // case B therefore fires document.linked for B, which is the
              // correct signal: B has just acquired this document.
              const r = await documents.link(db, row.id, 'case', hit.case_id, {
                relation:    documents.RELATION_PATH,
                eventSource: 'system',
              });
              if (r.created) linked++;
            }
          }
        }
        files += fileEntries.length;
      }

      // ── 3c. Deletes LAST ─────────────────────────────────────────────────
      // markDeletedByPath is prefix-aware: Dropbox reports a folder delete as
      // ONE entry with no descendants, so the cascade happens here or nowhere.
      for (const d of deletedEntries) {
        if (!d.path_lower) continue;
        deletedRows += await documents.markDeletedByPath(db, SOURCE, d.path_lower);
      }

      // ── 4. Persist the cursor, refresh the claim ─────────────────────────
      // AFTER the page is fully processed and BEFORE the next fetch. This
      // single write is what makes the whole thing resumable. Refreshing
      // syncing_since in the same statement keeps a long root from having its
      // claim expire out from under it mid-walk.
      cursor = page.cursor;
      await db.query(
        `UPDATE document_sync_roots SET sync_cursor = ?, syncing_since = NOW() WHERE id = ?`,
        [cursor, root.id],
      );

      if (!page.has_more) {
        stopReason = 'complete';
        // THE one moment the initial listing is provably complete. Everything
        // this cursor returns from here on is a genuine delta, so the root
        // graduates to emissions-on. Written in the finish block below, in the
        // same UPDATE as last_sync_at, so a crash before that leaves the root
        // in backfill — safe, at worst one redundant emissions-off pass.
        if (backfill) backfillCompleted = true;
        break;
      }
    }
  } catch (err) {
    // Root-level failure: record it, RELEASE THE CLAIM (so the next tick can
    // retry rather than waiting out 15 minutes), leave the cursor wherever
    // the last completed page left it. Re-throwing would abort the remaining
    // roots for a problem that is usually specific to one subtree.
    await db.query(
      `UPDATE document_sync_roots SET last_error = ?, syncing_since = NULL WHERE id = ?`,
      [_clamp(err.message, 1000), root.id],
    ).catch(() => {});
    return {
      root_id: root.id, path: root.path, mode, pages,
      files, linked, deleted: deletedRows,
      error: _clamp(err.message, 300), ms: Date.now() - startedAt,
    };
  }

  // ── 5. Finish ───────────────────────────────────────────────────────────
  const stats = {
    mode, pages, files, linked, deleted: deletedRows,
    // Omitted when zero so the common stats blob stays the shape S2 readers
    // already know, and a non-zero value stands out rather than blending in.
    ...(unlinked ? { unlinked } : {}),
    folder_heals: folderHeals, stop: stopReason, ms: Date.now() - startedAt,
  };
  await db.query(
    `UPDATE document_sync_roots
        SET last_sync_at = NOW(), last_error = NULL, stats = ?, syncing_since = NULL
            ${backfillCompleted ? ', backfill_done = 1' : ''}
      WHERE id = ?`,
    [JSON.stringify(stats), root.id],
  );

  return { root_id: root.id, path: root.path, ...stats,
           ...(backfillCompleted ? { backfill_completed: true } : {}) };
}

// ─────────────────────────────────────────────────────────────
// syncAll
// ─────────────────────────────────────────────────────────────

/**
 * Sync every enabled root under ONE shared page budget.
 *
 * Never-synced roots go first, then oldest-synced. The budget is shared
 * rather than per-root on purpose: Closed Cases alone is ~121,000 files, and
 * a per-root budget would let it consume its full allowance every tick
 * forever while the small roots wait behind it. Sharing means the queue
 * rotates — a root that exhausts the budget is last in line next tick.
 *
 * The cache is loaded ONCE and handed to every root.
 *
 * @param {object} db
 * @param {object} [opts] — { maxPages=25, maxRuntimeMs, credentialId? }
 */
async function syncAll(db, opts = {}) {
  const maxPages = _int(opts.maxPages, DEFAULT_MAX_PAGES);
  const deadline = Date.now() + _int(opts.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);
  const startedAt = Date.now();

  const [roots] = await db.query(
    `SELECT * FROM document_sync_roots
      WHERE enabled = 1
      ORDER BY (last_sync_at IS NULL) DESC, last_sync_at ASC, id ASC`,
  );

  const cache  = await _loadCaseFolderCache(db);
  const budget = { pages: maxPages };
  const results = [];

  for (const root of roots) {
    if (budget.pages <= 0)      break;
    if (Date.now() >= deadline) break;
    results.push(await syncRoot(db, root, {
      maxPages, budget, deadline, cache,
      ...(opts.credentialId != null ? { credentialId: opts.credentialId } : {}),
    }));
  }

  const errored = results.filter(r => r.error);
  if (errored.length) {
    await _alert(db, {
      source: 'app',
      kind: 'documents_sync_root_error',
      severity: 'error',
      group_key: 'documents_sync_root_error',
      title: `Documents sync: ${errored.length} root(s) failed`,
      message: errored.map(r => `root ${r.root_id} (${r.path}): ${r.error}`).join('\n'),
      context: { roots: errored.map(r => ({ root_id: r.root_id, error: r.error })) },
    });
  }

  return {
    roots: results,
    roots_considered: roots.length,
    pages_used: maxPages - budget.pages,
    cache_size: cache.size,
    elapsed_ms: Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// attributeUnlinked — the reconcile sweep
// ─────────────────────────────────────────────────────────────

/**
 * Link active documents that have NO PATH-LINK to a case but whose path now
 * matches a cached case folder. SILENT — always, unconditionally.
 *
 * "No path-link", not "no case link": see the anti-join's own comment. The
 * distinction only exists from S3.1 onward and it matters in one direction —
 * a manually-filed document still gains the path-link its location earns.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Inline attribution can only use the cache as it stood when the file was
 * ingested. On a fresh install the cache fills over hours while the backfill
 * is already running, so early pages register tens of thousands of files
 * against an empty or partial cache. Those files are correct rows with no
 * owner, and nothing else would ever revisit them.
 *
 * ── WHY IT NEVER EMITS ────────────────────────────────────────────────────
 * The first run after a backfill links six figures of rows. document.linked
 * per row would be the exact trigger-engine storm the backfill's emit:false
 * exists to prevent — and worse, it would fire case-scoped rules
 * retroactively across the firm's entire document history. See the
 * EVENT-SEMANTICS GAP note in the file header: this silence is a known,
 * accepted limitation, not an omission.
 *
 * ── WHY IT SWEEPS ON A WATERMARK AND NOT JUST `LIMIT n` ───────────────────
 * A bare `… AND dl.id IS NULL LIMIT 5000` STARVES, and it starves silently.
 * Observed on the first production run: scanned 5000, linked 152. The other
 * 4,848 rows are documents that legitimately match no case — files under the
 * "Unsorted …" roots, loose firm documents, cases with no Dropbox folder —
 * and because the query has no ordering key that advances, the NEXT run
 * returns the same 4,848 rows plus a handful more. That head of permanently
 * unmatchable rows crowds out every document behind it, forever. With 150k
 * documents and 1,009 case folders that arrive over hours, the sweep would
 * have re-tested the same first 5,000 rows until the end of time and never
 * once looked at row 60,000.
 *
 * So the scan advances a WATERMARK (app_settings, one integer) over
 * documents.id and wraps to 0 when it reaches the end. Each run tests a fresh
 * window; the whole table is covered over successive runs; permanently
 * unmatchable rows cost one visit per lap instead of every run. The wrap is
 * what keeps it correct rather than merely cheap — the cache keeps growing,
 * so a row that matched nothing on lap 1 may well match on lap 3.
 *
 * ── THE STEADY-STATE COST ─────────────────────────────────────────────────
 * One `limit`-sized window per run, driven by the PRIMARY KEY range and
 * uq_doc_target (document_id, link_type, link_id) as the join index. A full
 * lap over 150k documents at 5,000/run is 30 runs — five hours at the
 * 10-minute cadence, which is the right order of magnitude for "a case folder
 * got cached late". REVISIT THRESHOLD: if a lap needs to be faster than that,
 * add a `case_link_checked_at` column so a document is only re-tested after
 * the cache actually changes — do not just raise the limit, which buys a
 * bigger window and the same lap count.
 *
 * @param {object} db
 * @param {object} [opts] — { limit=5000, watermark:false to disable }
 * @returns {Promise<{scanned, linked, from_id, next_id, wrapped, ...}>}
 */
const SWEEP_WATERMARK_KEY = 'documents_sweep_watermark';

async function attributeUnlinked(db, opts = {}) {
  const limit = Math.min(_int(opts.limit, 5000), 50000);
  const startedAt = Date.now();

  const cache = opts.cache || await _loadCaseFolderCache(db);
  if (!cache.size) {
    return { scanned: 0, linked: 0, limit, elapsed_ms: Date.now() - startedAt };
  }

  // Where the last run stopped. A missing/garbage row is a valid starting
  // state (0), not an error — this is a position hint, never a correctness
  // dependency: losing it re-walks the table, which is merely slower.
  let fromId = 0;
  if (opts.watermark !== false) {
    const [[wm]] = await db.query(
      'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1', [SWEEP_WATERMARK_KEY],
    );
    const n = Number(wm && wm.value);
    if (Number.isFinite(n) && n > 0) fromId = Math.floor(n);
  }

  // ORDER BY d.id is load-bearing, not cosmetic: it is what makes the window
  // advance. Without it MySQL is free to return the same head every time and
  // the sweep starves (see the docblock).
  //
  // ── THE ANTI-JOIN IS KEYED ON PATH-LINKS, NOT ON CASE LINKS (S3.1) ──────
  // It used to mean "has no case link at all", which under the hygiene rule is
  // wrong in one direction: a document a staffer manually linked to case A,
  // sitting in case B's folder, looked attributed and was skipped forever — so
  // it never acquired B's path-link and never appeared in B's documents. The
  // manual link says where a person filed it; the path-link says where the
  // FILE is. Both are true at once and the sweep owns only the second.
  //
  // This ADDS ONLY. A document that already holds the right path-link is
  // skipped by the join exactly as before, and one that holds a WRONG
  // path-link (a move the incremental path saw) is skipped here too — the
  // reconciler already retracted it, and re-deciding that from a watermark
  // sweep with a stale cache would fight the engine that has the delta.
  //
  // PLAN (EXPLAIN against the live DB, 2026-08-27): dl stays type=ref on
  // uq_doc_target with `Not exists`, driven by (document_id, link_type). It
  // loses the old form's `Using index` — `relation` is not in the index, so
  // the row is now fetched to test it — which costs one row read per candidate
  // and is bounded by `limit` per run.
  const [rows] = await db.query(
    `SELECT d.id, d.path_lower
       FROM documents d
       LEFT JOIN document_links dl
         ON dl.document_id = d.id
        AND dl.link_type = 'case'
        AND dl.relation = ?
      WHERE d.status = 'active'
        AND d.path_lower IS NOT NULL
        AND dl.id IS NULL
        AND d.id > ?
      ORDER BY d.id
      LIMIT ${limit}`,
    [documents.RELATION_PATH, fromId],
  );

  const links = [];
  for (const r of rows) {
    const hit = _matchCase(cache.byPath, r.path_lower);
    if (hit) {
      links.push({
        document_id: r.id, link_type: 'case', link_id: hit.case_id,
        relation: documents.RELATION_PATH,
      });
    }
  }

  if (links.length) await documents.bulkLink(db, links);

  // A short page means we reached the end of the table: wrap to 0 so the next
  // run starts a fresh lap. The cache grows between laps, so re-testing a row
  // that matched nothing last lap is the POINT, not waste.
  const wrapped = rows.length < limit;
  const nextId = wrapped ? 0 : rows[rows.length - 1].id;

  if (opts.watermark !== false) {
    await db.query(
      'INSERT INTO app_settings (`key`, `value`, is_secret, is_editable) ' +
      'VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [SWEEP_WATERMARK_KEY, String(nextId)],
    );
  }

  return {
    scanned: rows.length, linked: links.length, limit,
    from_id: fromId, next_id: nextId, wrapped,
    elapsed_ms: Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// attributionReport — DIAGNOSTIC ONLY, mutates nothing
// ─────────────────────────────────────────────────────────────

/** Documents per page in the residue scan. Bounded; see the docblock. */
const REPORT_PAGE = 10000;

/** Wall-clock bound for one report run. Same reasoning as everywhere else here. */
const DEFAULT_REPORT_RUNTIME_MS = 3 * 60 * 1000;

/** Cases listed individually in the output before it truncates. */
const REPORT_SAMPLE = 50;

/**
 * Report cases whose folder resolved cleanly but hold NO attributed documents,
 * and — for each — how many registered documents still sit under that cached
 * path. READ-ONLY: no links written, no cache rows touched, no events.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `out_of_root` (refreshCaseFolderCache) answers "is this folder watched?".
 * It cannot catch the failure that actually bit us: `cases.case_dropbox` still
 * holds the shared link minted at INTAKE, staff later moved the case's
 * contents into a NEW working folder, and nobody re-pointed the case record.
 * The intake folder is watched perfectly — it is simply empty — so out_of_root
 * reports clean while the case's real documents go unattributed. 843 of 986
 * cached folders resolve into Potential Cases, and only 427 of those cases
 * have any document at all; the ~416 remainder were invisible until a link
 * deletion made them conspicuous.
 *
 * ── WHAT THE RESIDUE COUNT SETTLES ────────────────────────────────────────
 * The single-folder ruling rests on an inference from ONE worked example:
 * that intake contents are MOVED, leaving empty history not worth a schema
 * change. Residue tests that inference across the whole estate before S3.3 is
 * chartered. Empty-abandoned everywhere confirms it; meaningful residue
 * re-opens multi-folder with data rather than a lifecycle theory.
 *
 * Residue is broken out by WHY a document is still there, because the
 * categories mean different things:
 *
 *   deleted                 — files WERE here and were removed. Consistent
 *                             with "moved out"; supports single-folder.
 *   active_linked_elsewhere — a LIVE file under case A's folder attributed to
 *                             case B. The interesting signal: either a real
 *                             mis-link or a genuinely shared folder, and the
 *                             one that would re-open the question.
 *   active_unlinked         — should be structurally IMPOSSIBLE after a full
 *                             sweep lap: attributeUnlinked links exactly this
 *                             shape. A non-zero count is a SWEEP BUG, not a
 *                             lifecycle finding. Surfaced separately so the
 *                             two can never be confused.
 *
 * ── WHY A FULL SCAN, AND WHY IT IS ITS OWN FUNCTION ───────────────────────
 * `documents.path_lower` is TEXT with no index (verified: documents carries
 * PRIMARY, uq_source_ext, path_hash, type, status, updated, server_modified,
 * ft_docs — nothing on path_lower). So "documents under this folder" cannot
 * be an indexed lookup. The obvious SQL —
 *     JOIN case_folder_cache f ON d.path_lower LIKE CONCAT(f.path_lower,'/%')
 * — is a 986 × 153k cross join and TIMES OUT on the readonly endpoint. It is
 * done here instead: one paged pass over documents, matched in memory against
 * a Set holding only the zero-attribution paths, using the same segment-safe
 * _matchCase walk as the sweep.
 *
 * That scan is why this is a SIBLING of refreshCaseFolderCache rather than
 * bolted into it. That function is wall-clock bound at 4 minutes precisely
 * because its sequential Dropbox calls are slow; hanging an unbounded table
 * scan off it would make a bounded function unbounded again. Same report,
 * none of the coupling.
 *
 * @param {object} db
 * @param {object} [opts] — { maxRuntimeMs, sample }
 * @returns {Promise<object>} counts + a truncated per-case sample
 */
async function attributionReport(db, opts = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + _int(opts.maxRuntimeMs, DEFAULT_REPORT_RUNTIME_MS);
  const sampleSize = Math.min(_int(opts.sample, REPORT_SAMPLE), 500);

  // Cached folders with NO case link anywhere. Cheap: idx_dl_target is
  // (link_type, link_id), which is exactly this join.
  const [zeroRows] = await db.query(
    `SELECT f.case_id, f.path_lower, f.resolved_at
       FROM case_folder_cache f
       LEFT JOIN document_links dl
         ON dl.link_type = 'case' AND dl.link_id = f.case_id
      WHERE f.path_lower IS NOT NULL AND f.path_lower <> ''
        AND dl.id IS NULL`,
  );

  const [[totals]] = await db.query(
    `SELECT COUNT(*) AS cached FROM case_folder_cache
      WHERE path_lower IS NOT NULL AND path_lower <> ''`,
  );

  const base = {
    cached_folders: totals ? totals.cached : 0,
    zero_attribution_cases: zeroRows.length,
  };

  if (!zeroRows.length) {
    return {
      ...base, cases_with_residue: 0, residue_total: 0,
      residue_deleted: 0, residue_active_linked_elsewhere: 0, residue_active_unlinked: 0,
      verdict: 'no_zero_attribution_cases',
      scanned_documents: 0, pages: 0, timed_out: false,
      elapsed_ms: Date.now() - startedAt, sample: [],
    };
  }

  // Only the zero-attribution paths go in the map — every other cached folder
  // is irrelevant here and would just slow the walk.
  const targets = new Map();
  for (const r of zeroRows) {
    targets.set(String(r.path_lower), {
      case_id: r.case_id, path_lower: r.path_lower,
      total: 0, deleted: 0, active_linked_elsewhere: 0, active_unlinked: 0,
    });
  }

  let fromId = 0, pages = 0, scanned = 0, timedOut = false;
  for (;;) {
    if (Date.now() >= deadline) { timedOut = true; break; }

    // GROUP BY d.id is load-bearing: a document with several case links would
    // otherwise arrive once per link and be counted several times. (This
    // schema runs without ONLY_FULL_GROUP_BY, so the bare columns are fine —
    // same relaxation listCases depends on.)
    const [rows] = await db.query(
      `SELECT d.id, d.path_lower, d.status,
              MAX(dl.id IS NOT NULL) AS has_case_link
         FROM documents d
         LEFT JOIN document_links dl
           ON dl.document_id = d.id AND dl.link_type = 'case'
        WHERE d.id > ? AND d.path_lower IS NOT NULL
        GROUP BY d.id
        ORDER BY d.id
        LIMIT ${REPORT_PAGE}`,
      [fromId],
    );
    if (!rows.length) break;

    pages++;
    scanned += rows.length;
    for (const r of rows) {
      const hit = _matchCase(targets, r.path_lower);
      if (!hit) continue;
      hit.total++;
      if (r.status === 'deleted') hit.deleted++;
      else if (Number(r.has_case_link)) hit.active_linked_elsewhere++;
      else hit.active_unlinked++;
    }

    fromId = rows[rows.length - 1].id;
    if (rows.length < REPORT_PAGE) break;
  }

  const withResidue = [...targets.values()]
    .filter(t => t.total > 0)
    .sort((a, b) => b.total - a.total);

  const sum = k => withResidue.reduce((n, t) => n + t[k], 0);
  const residueTotal = sum('total');
  const activeElsewhere = sum('active_linked_elsewhere');
  const activeUnlinked = sum('active_unlinked');

  return {
    ...base,
    cases_with_residue: withResidue.length,
    residue_total: residueTotal,
    residue_deleted: sum('deleted'),
    residue_active_linked_elsewhere: activeElsewhere,
    residue_active_unlinked: activeUnlinked,
    // The ruling's test, stated plainly. active_unlinked is deliberately NOT
    // part of it — that count is a sweep bug, not a lifecycle finding.
    verdict: timedOut
      ? 'incomplete_scan'
      : (activeElsewhere === 0
          ? 'empty_abandoned — single-folder model holds'
          : 'live_residue — re-open multi-folder'),
    ...(activeUnlinked > 0
      ? { WARNING: `${activeUnlinked} active unlinked documents sit under a zero-attribution ` +
                   `folder. attributeUnlinked should have linked these — investigate the sweep, ` +
                   `this is not a lifecycle signal.` }
      : {}),
    scanned_documents: scanned, pages, timed_out: timedOut,
    elapsed_ms: Date.now() - startedAt,
    sample: withResidue.slice(0, sampleSize),
    sample_truncated: withResidue.length > sampleSize,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SYNC ROOTS — admin surface (S3.2)
//
// The routes layer owns no SQL (see routes/api.documents.js's header), and this
// file already owns every other write to document_sync_roots — the claim, the
// cursor, the stats blob, last_error. Root management belongs here with them,
// next to the invariants it has to protect.
//
// ── THERE IS NO DELETE, AND THAT IS THE DESIGN ────────────────────────────
// A root's rows do not carry a root_id — attribution is by PATH, and the link
// between a document and the root that walked it exists only in the prefix.
// Deleting root 3 would therefore leave ~100,000 `documents` rows that no
// remaining root claims, that no sync will ever revisit, and that nothing
// marks as stale: they would simply sit in the registry asserting a truth
// nobody is checking any more. DISABLE is the safe verb, and it is the only
// one this module offers. `enabled = 0` stops the rotation, keeps the cursor,
// and can be undone.
// ═════════════════════════════════════════════════════════════════════════════

/** document_sync_roots.path — VARCHAR(512). See _validateRootPath re: clamping. */
const ROOT_PATH_MAX = 512;

/** document_sync_roots.note — VARCHAR(255). Clamped; a shortened note is harmless. */
const ROOT_NOTE_MAX = 255;

/**
 * Columns the admin panel reads.
 *
 * `sync_cursor` is DELIBERATELY NOT among them — it is an opaque multi-kilobyte
 * Dropbox paging token, it means nothing to a human, and shipping it to a
 * browser on every panel open is pure weight. What the UI actually needs from
 * it is the boolean, so that is what it gets.
 */
const ROOT_COLUMNS = `
  id, path, note, enabled, backfill_done, syncing_since,
  last_sync_at, last_error, stats, created_at,
  (sync_cursor IS NOT NULL) AS has_cursor`;

/** Normalize a root row for the wire: MySQL's tinyints → real booleans. */
function _rootOut(r) {
  if (!r) return null;
  return {
    ...r,
    enabled:       !!Number(r.enabled),
    backfill_done: !!Number(r.backfill_done),
    has_cursor:    !!Number(r.has_cursor),
    // A JSON column comes back parsed; a TEXT one would not. Tolerate both
    // rather than assuming, because this same shape is asserted in tests
    // against a stub that has no column types at all.
    stats: typeof r.stats === 'string' ? _safeJson(r.stats) : (r.stats || null),
  };
}

function _safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

/**
 * Validate and normalize a proposed root path. Throws on anything unusable.
 *
 * ── WHY AN OVER-LONG PATH IS REJECTED AND NOT CLAMPED ─────────────────────
 * Every other string in this stack is clamped, because this DB has no
 * STRICT_TRANS_TABLES and a silent truncation is worse than a visible one. A
 * root path is the exception, and it is the exception for a reason that only
 * applies here: a truncated path is not a shortened label, it is A DIFFERENT
 * FOLDER. `/a/b/c/d` clamped to `/a/b/c` is very likely to exist — it is the
 * parent — and the engine would then recursively walk a subtree far larger
 * than the one anybody asked for, emissions and all. Clamping the note costs a
 * few characters of prose; clamping the path costs a storm. So: reject, loudly,
 * with the length in the message.
 *
 * Dropbox itself caps a path well under 512, so this is a typo/paste guard
 * rather than a real constraint anyone will meet.
 */
function _validateRootPath(raw) {
  const s = raw == null ? '' : String(raw);
  if (!s.trim()) throw new Error('path is required');

  // Handles ("id:…", "ns:…") are passthrough in normalizePath and are NOT a
  // watchable subtree — list_folder against one behaves differently and
  // nothing downstream (attribution is prefix-based) would work. Require a
  // real path, said plainly.
  if (!s.startsWith('/')) {
    throw new Error('path must start with "/" (a full Dropbox folder path, not an id: handle)');
  }
  if (s.length > ROOT_PATH_MAX) {
    throw new Error(
      `path is ${s.length} characters; the limit is ${ROOT_PATH_MAX}. ` +
      'It is rejected rather than shortened — a truncated path is a different folder.',
    );
  }

  // Collapses "//", strips ONE trailing slash, and — critically — NEVER touches
  // whitespace: this firm's folders are named "  Active Cases" and the leading
  // spaces are load-bearing sort keys, not formatting.
  const path = dropbox.normalizePath(s);
  if (!path) {
    // normalizePath maps "/" to "" — the account root. A root there would walk
    // the entire Dropbox on every backfill.
    throw new Error('the Dropbox account root cannot be a sync root — name a folder');
  }
  return path;
}

/**
 * Reject a path that would nest with an existing ENABLED root, in EITHER
 * direction, and return the conflicting row so the caller can name it.
 *
 * Nesting is not a style objection. Two roots where one contains the other
 * means every file in the inner subtree is listed twice per lap, upserted
 * twice, and (on the incremental path) emits twice — a doubled trigger-engine
 * load for zero additional coverage, since the outer root already reaches
 * every one of those files.
 *
 * `_underRoot` is reused rather than `startsWith` for the same reason
 * attribution uses it: "/x/  case a" must not be considered inside
 * "/x/  case" — only whole segments count.
 *
 * DISABLED roots are checked too, but only on the way IN to an enabled state
 * (add, and enable). A disabled root is inert, so it cannot double-walk
 * anything today; letting it sit is fine, letting it be switched on into a
 * conflict is not.
 */
function _findNestingConflict(rows, path, selfId = null) {
  const lower = path.toLowerCase();
  for (const r of rows) {
    if (selfId != null && String(r.id) === String(selfId)) continue;
    if (!Number(r.enabled)) continue;
    const other = String(r.path).toLowerCase();
    if (other === lower) continue;                 // duplicate, handled separately
    if (_underRoot(lower, other)) {
      return { row: r, direction: 'inside' };      // the new path is inside r
    }
    if (_underRoot(other, lower)) {
      return { row: r, direction: 'contains' };    // the new path contains r
    }
  }
  return null;
}

/** All roots, newest state, for the admin panel. Includes DISABLED ones. */
async function listRoots(db) {
  const [rows] = await db.query(
    `SELECT ${ROOT_COLUMNS} FROM document_sync_roots ORDER BY id ASC`,
  );
  return rows.map(_rootOut);
}

/** One root, or null. */
async function getRoot(db, id) {
  const [[row]] = await db.query(
    `SELECT ${ROOT_COLUMNS} FROM document_sync_roots WHERE id = ? LIMIT 1`, [id],
  );
  return _rootOut(row) || null;
}

/**
 * The FULL row (cursor included) — what syncRoot needs and the panel must not
 * see. Kept separate from getRoot so the distinction is impossible to blur.
 */
async function getRootRaw(db, id) {
  const [[row]] = await db.query(
    'SELECT * FROM document_sync_roots WHERE id = ? LIMIT 1', [id],
  );
  return row || null;
}

/**
 * Add a sync root.
 *
 * ── WHY AN ADD BUTTON IS SAFE TO EXPOSE AT ALL ────────────────────────────
 * A new root starts `backfill_done = 0` with a NULL cursor, so its first walk
 * runs in BACKFILL mode by construction — bulk writes, emissions OFF. Pointing
 * a root at a folder holding 40,000 historical files therefore cannot storm
 * the trigger engine, which is the only thing that would make this a dangerous
 * button. (See the file header on why mode is derived rather than stored.)
 *
 * ── A FOLDER THAT DOES NOT EXIST YET IS A LEGITIMATE ROOT ─────────────────
 * Three of the seeded roots are created lazily by the upload / e-sign / forms
 * ladders and do not exist in Dropbox today. syncRoot already treats
 * `path/not_found` as an EMPTY root rather than an error, precisely so those
 * do not sit in a permanent failure state. So a stat miss here is a WARNING on
 * a successful create, not a rejection — the root will simply start syncing on
 * the tick after the folder appears.
 *
 * @param {object} db
 * @param {object} input — { path, note? }
 * @param {object} [opts] — { credentialId? }
 * @returns {Promise<{root: object, warning: string|null}>}
 */
async function addRoot(db, input = {}, opts = {}) {
  const path = _validateRootPath(input.path);
  const note = _clamp(input.note, ROOT_NOTE_MAX);

  const [existing] = await db.query('SELECT id, path, note, enabled FROM document_sync_roots');

  // CASE-INSENSITIVE duplicate test. Two reasons, and the second is the real
  // one: (1) the column collates utf8mb4_general_ci, so MySQL would consider
  // them equal anyway; (2) Dropbox paths are case-INSENSITIVE and
  // case-PRESERVING — "/Foo" and "/foo" are the same folder to the API — and
  // this engine's entire attribution layer runs on `path_lower`. Two roots
  // differing only in case are one folder walked twice.
  const dupe = existing.find(r => String(r.path).toLowerCase() === path.toLowerCase());
  if (dupe) {
    const err = new Error(`that path is already a sync root (root ${dupe.id})`);
    err.status = 409;
    throw err;
  }

  const conflict = _findNestingConflict(existing, path);
  if (conflict) {
    const err = new Error(
      conflict.direction === 'inside'
        ? `this path sits INSIDE root ${conflict.row.id} ("${conflict.row.path}"), which already ` +
          'walks it recursively — every file underneath would be synced twice'
        : `this path CONTAINS root ${conflict.row.id} ("${conflict.row.path}") — every file under ` +
          'that root would be synced twice. Disable it first, or pick a narrower path',
    );
    err.status = 409;
    throw err;
  }

  // PROVIDER STAT, before the insert. Two things it settles: whether the
  // folder exists (a miss is a warning, see above) and whether it is a FOLDER
  // at all. A root pointing at a file would fail list_folder on every tick
  // forever with an error nobody can act on from the message alone.
  let warning = null;
  try {
    const meta = await dropbox.getMetadata(db, {
      path,
      ...(opts.credentialId != null ? { credentialId: opts.credentialId } : {}),
    });
    if (meta && meta['.tag'] === 'file') {
      const err = new Error('that path is a file — a sync root must be a folder');
      err.status = 400;
      throw err;
    }
  } catch (err) {
    if (dropbox.isPathNotFoundError(err)) {
      warning = 'folder does not exist yet — will sync when created';
    } else {
      throw err;                       // 400 above, or a real provider failure
    }
  }

  const [ins] = await db.query(
    `INSERT INTO document_sync_roots (path, note, enabled, backfill_done, sync_cursor)
     VALUES (?, ?, 1, 0, NULL)`,
    [path, note],
  );

  return { root: await getRoot(db, ins.insertId), warning };
}

/**
 * Flip `enabled`. THE ONLY MUTABLE FIELD ON A ROOT, and the restriction is
 * deliberate rather than lazy.
 *
 * ── WHY `path` IS NOT EDITABLE ────────────────────────────────────────────
 * A root's cursor is a Dropbox delta token FOR A SPECIFIC FOLDER. Repointing
 * the path while keeping the cursor means the next tick asks Dropbox "what
 * changed under the OLD folder since this token" and writes the answers as if
 * they belonged to the new one. And the rows already registered under the old
 * prefix keep their path-based case attribution, which nothing would ever
 * revisit. A path edit is therefore not an edit — it is a different root that
 * happens to reuse a primary key. If a path is wrong: disable it, add the
 * right one.
 *
 * Enabling re-checks nesting for the same reason adding does: a conflict
 * created by the back door doubles the walk exactly as much as one created by
 * the front.
 */
async function setRootEnabled(db, id, enabled) {
  const want = enabled ? 1 : 0;
  const current = await getRoot(db, id);
  if (!current) return null;

  if (want === 1) {
    const [existing] = await db.query('SELECT id, path, note, enabled FROM document_sync_roots');
    const conflict = _findNestingConflict(existing, String(current.path), id);
    if (conflict) {
      const err = new Error(
        `cannot enable: this root ${conflict.direction === 'inside' ? 'sits inside' : 'contains'} ` +
        `root ${conflict.row.id} ("${conflict.row.path}") — every file underneath would be synced twice`,
      );
      err.status = 409;
      throw err;
    }
  }

  await db.query('UPDATE document_sync_roots SET enabled = ? WHERE id = ?', [want, id]);
  return getRoot(db, id);
}

/**
 * Kill-switch read, fail-closed. Absent, blank, or anything but the exact
 * string '1' means DISABLED.
 *
 * Lives here so the engine and every caller that fronts it read the switch
 * through ONE function. lib/internal_functions/documents.js delegates to this
 * rather than keeping its own copy of the comparison — two readers of a kill
 * switch is two chances for them to disagree about what '1 ' means, and the
 * whole value of a fail-closed switch is that it has no second opinion.
 * (See that file's header for why this is settingsService and not firmConfig.)
 */
async function isSyncEnabled(db) {
  const { getSetting } = require('./settingsService'); // lazy require (convention)
  return (await getSetting(db, 'documents_sync_enabled')) === '1';
}

// ─────────────────────────────────────────────────────────────
// Diagnostics — what the recurring reports last said
// ─────────────────────────────────────────────────────────────

/**
 * The internal functions whose job_results carry a report worth surfacing.
 * `documents_sync` is deliberately absent: its per-root outcome is already
 * persisted on the root row itself (stats / last_error), which the panel reads
 * directly and which is fresher than any job row.
 */
const DIAGNOSTIC_FUNCTIONS = [
  'documents_refresh_case_cache',
  'documents_attribution_report',
];

/**
 * How many recent job_results rows to scan per job. Bounded because the point
 * is "the latest run, and the latest USABLE one" — not history. At a 4-hourly
 * cadence, 40 rows is nearly a week.
 */
const DIAG_SCAN_LIMIT = 40;

/**
 * Latest report per diagnostic function, read out of job_results.
 *
 * ── WHY THE LATEST RUN AND THE LATEST *USABLE* RUN ARE BOTH RETURNED ──────
 * They are routinely not the same row, and the difference is the finding. Two
 * ways a run produces no report:
 *
 *   failed   — the job threw. output_data is NULL.
 *   skipped  — the kill switch was off, so the function returned
 *              { skipped: true } and never looked at anything.
 *
 * A panel that showed only the newest row would render an empty diagnostics
 * block on both, which reads exactly like "nothing to report" — the one
 * meaning it does not have. So: `last_run` says what happened most recently,
 * `last_report` is the most recent row that actually contains findings, and
 * `consecutive_failures` counts the streak inside the scanned window. Verified
 * against production 2026-08-27: the newest eight runs of
 * documents_refresh_case_cache had all failed, and every successful row behind
 * them was a kill-switch skip.
 *
 * READ-ONLY, and it re-derives nothing. The correlated-LIKE shape that would
 * recompute zero-attribution in SQL is a 986 × 153k cross join that times out;
 * attributionReport does that work in memory against a Set. This function only
 * reads what a run already wrote.
 *
 * @param {object} db
 * @param {string[]} [functionNames]
 * @returns {Promise<object[]>} one entry per function, whether or not it has run
 */
async function latestJobReports(db, functionNames = DIAGNOSTIC_FUNCTIONS) {
  const names = (functionNames || []).filter(Boolean);
  if (!names.length) return [];

  // scheduled_jobs.data is a JSON column holding { type:'internal_function',
  // function_name, params } — see lib/job_executor.js. A function may have
  // several jobs (or none), so this is a list, not a lookup.
  const [jobs] = await db.query(
    `SELECT id, name, status,
            JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) AS function_name
       FROM scheduled_jobs
      WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.function_name')) IN (?)`,
    [names],
  );

  const byFn = new Map(names.map(n => [n, {
    function_name: n, jobs: [], last_run: null, last_report: null,
    consecutive_failures: 0, scanned: 0,
  }]));

  const jobIds = jobs.map(j => j.id);
  for (const j of jobs) {
    const slot = byFn.get(j.function_name);
    if (slot) slot.jobs.push({ job_id: j.id, name: j.name, status: j.status });
  }

  if (jobIds.length) {
    // One indexed range per job (idx_job on job_results.job_id), newest first,
    // bounded. `id DESC` rather than executed_at: it is the primary key, it is
    // monotonic, and two runs inside the same second would otherwise have no
    // defined order.
    const [rows] = await db.query(
      `SELECT id, job_id, status, output_data, error_message, duration_ms, executed_at
         FROM job_results
        WHERE job_id IN (?)
        ORDER BY id DESC
        LIMIT ${DIAG_SCAN_LIMIT * jobIds.length}`,
      [jobIds],
    );

    const fnOfJob = new Map(jobs.map(j => [String(j.id), j.function_name]));

    for (const r of rows) {
      const slot = byFn.get(fnOfJob.get(String(r.job_id)));
      if (!slot) continue;
      slot.scanned++;

      // output_data is a JSON column (parsed by mysql2) holding the internal
      // function's whole envelope: { success, output }. The report is the
      // INNER object — reaching for output_data directly gets the envelope and
      // silently finds no fields.
      const envelope = typeof r.output_data === 'string'
        ? _safeJson(r.output_data) : (r.output_data || null);
      const report = envelope && envelope.output ? envelope.output : null;
      const skipped = !!(report && report.skipped);

      const entry = {
        result_id:  r.id,
        job_id:     r.job_id,
        status:     r.status,
        executed_at: r.executed_at,
        duration_ms: r.duration_ms,
        ...(r.error_message ? { error_message: _clamp(r.error_message, 500) } : {}),
        ...(skipped ? { skipped: true, skip_reason: report.reason || null } : {}),
      };

      if (!slot.last_run) slot.last_run = entry;
      if (!slot.last_report && r.status === 'success' && report && !skipped) {
        slot.last_report = { ...entry, report };
      }
    }

    // The streak, counted from the newest row backwards. Bounded by the scan
    // window, so it is a floor ("at least N"), never an overstatement.
    for (const slot of byFn.values()) {
      let streak = 0;
      for (const r of rows) {
        if (fnOfJob.get(String(r.job_id)) !== slot.function_name) continue;
        if (r.status !== 'failed') break;
        streak++;
      }
      slot.consecutive_failures = streak;
    }
  }

  return [...byFn.values()];
}

// ═════════════════════════════════════════════════════════════════════════════
// GUIDED RE-LINK (S3.3)
//
// ── THE ONE RULE ──────────────────────────────────────────────────────────
// NO LINK IS EVER CHANGED WITHOUT A HUMAN CONFIRMING THE SPECIFIC PAIRING.
// Everything in this section generates SUGGESTIONS and validates a CHOICE.
// Nothing here re-points a case on its own, and nothing here ever will: a
// wrong link puts Client A's bankruptcy documents on Client B's case page,
// in a view (S3.1's related-documents) that fans them out to every contact
// related to that case as well. There is no "probably right" tier that is
// safe to automate.
//
// ── WHAT THE QUEUE ACTUALLY CONTAINS, MEASURED ────────────────────────────
// The charter for this slice said the 418 zero-attribution cases were filed
// cases whose contents had been moved to a new working folder at filing. The
// live data says otherwise, and the correction matters because it decides
// what this UI is FOR:
//
//     pipeline_phase = 'intake'            410
//     pipeline_phase = 'case'                8
//     have a case_number_full                5
//     cached folder holds >= 1 file           0
//
// 410 of 418 were never filed. There was no move. They are potential-case
// intake folders that are empty because the client never sent a document —
// the ordinary end state of a lead that did not convert. Ranking every one of
// them against the estate finds a confident candidate for roughly 24.
//
// So this is not a bulk-repair tool. It is a careful instrument for the small
// minority that IS repairable, plus an honest way to clear the rest off the
// board (see setRelinkDismissed). A UI built on the original premise would
// have presented 418 rows as if 418 repairs were waiting.
//
// ── WHY THE NAME LANE IS CONJUNCTIVE AND NOT RANKED-BY-OVERLAP ────────────
// Overlap ranking was specified and was implemented literally and measured
// before it was rejected. It produces a candidate for 323 of the 418, and the
// TOP-RANKED one is routinely a different client:
//
//     Natasha MITCHELL   -> " mitchell, vinyanda - 21-4989..."   (surname)
//     Juicey MCCOY       -> " 7 - mccoy, darwin..."              (surname)
//     NORMAN Greenberg   -> " reedy, norman"                     (GIVEN name)
//     BETHANY Gruebbs    -> " lobur, bethany 2"                  (GIVEN name)
//
// Each of those would have rendered with a confirm button next to it. The
// structural argument is what settles it: the folder templates interpolate
// {{lfm_name}}, so any folder this system ever created carries the full
// "Surname, Given" string. A surname-only hit therefore essentially CANNOT be
// the right folder — it is a different client with a common last name.
//
// So `name` requires EVERY token of a related contact's lfm_name to be present
// in the candidate's own folder-name segment. Surname-only survives as `weak`,
// is omitted from the response unless the caller asks for it, and carries its
// own separate confirmation in the UI. 323 suggestions become 20.
//
// ── WHY THE FOLDER INVENTORY IS ONE GROUPED QUERY ─────────────────────────
// attributionReport's docblock warns that "documents under this folder" cannot
// be an indexed lookup (path_lower is TEXT with no index) and that the
// correlated form — JOIN case_folder_cache ON d.path_lower LIKE CONCAT(f.path_lower,'/%')
// — is a 986 x 153k cross join that times out. That warning is about the
// CORRELATION, not about touching the table: one UNcorrelated GROUP BY over
// the same rows collapses 153,149 documents into 8,423 directories in 800ms,
// measured against production. The transitive roll-up then happens in memory,
// where it is ~67k map operations.
//
// Copying the paged-scan idiom here instead would have cost 3-5 seconds on
// every panel open for no benefit. The warning was worth reading; it was not
// worth obeying past the case it describes.
// ═════════════════════════════════════════════════════════════════════════════

/** Candidates returned per case. More than this is noise, not choice. */
const RELINK_CANDIDATE_CAP = 10;

/** Shortest name/docket token worth matching. Below this, initials collide. */
const RELINK_TOKEN_MIN = 3;

/**
 * How long a built folder inventory may be reused within one process.
 *
 * Safe because the inventory is derived ENTIRELY from `documents.path_lower`,
 * which only ever changes when the sync engine walks a root. A confirm writes
 * `document_links` and `cases.case_dropbox` — neither of which the inventory
 * reads — so no action taken through this surface can invalidate it. The
 * window exists because the panel asks for the whole queue at once and then
 * re-asks per case after each confirm.
 */
const RELINK_INVENTORY_TTL_MS = 60 * 1000;

/** Rows the post-confirm targeted attribution will consider in one pass. */
const RELINK_ATTRIBUTION_CAP = 20000;

/** Cases one dismiss call may stamp. Bounds the IN() list, nothing more. */
const RELINK_DISMISS_CAP = 500;

/** Related contacts whose names feed the name lane, Primary first. */
const RELINK_CONTACT_CAP = 6;

/** Cases the batch candidate builder will rank in one request. */
const RELINK_BATCH_CAP = 500;

/**
 * Distinct OTHER cases cached strictly beneath a folder before it is treated
 * as a TYPE level rather than a case folder.
 *
 * Two, not one, and the difference is a real row: production has a closed case
 * folder ("... 7 - stewart, david a. - ...") with a *potential* case's folder
 * nested inside it. At a threshold of one, that legitimate case folder would
 * be silently excluded from its own client's candidate list. A genuine type
 * level ("  active - bankruptcy") holds hundreds.
 */
const TYPE_LEVEL_MIN_CASES = 2;

/** cases.case_dropbox is VARCHAR(255). See the reject-don't-clamp note below. */
const CASE_DROPBOX_MAX = 255;

/**
 * Dropped from name tokens. Deliberately tiny: an aggressive stop list turns a
 * conjunctive match into a looser one, which is the exact direction this lane
 * must never drift.
 */
const NAME_STOPWORDS = new Set([
  'the', 'and', 'llc', 'inc', 'ltd', 'jr', 'sr', 'ii', 'iii', 'iv',
  'mr', 'mrs', 'ms', 'dr', 'esq',
]);

/** Relate types whose contacts count as "this case's client names". */
const RELINK_RELATE_TYPES = ['Primary', 'Secondary', 'Other'];

/** Comparable timestamp, tolerant of Date | string | null (stubs pass strings). */
function _ts(v) {
  if (!v) return 0;
  const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** LIKE-metacharacter escape. Paired with ESCAPE '|' at every call site. */
function _likeEscape(s) {
  return String(s).replace(/([|%_])/g, '|$1');
}

/** The directory part of a path, or '' for a root-level file. */
function _dirOf(p) {
  const i = String(p).lastIndexOf('/');
  return i > 0 ? String(p).slice(0, i) : '';
}

/** The last segment of a path — the folder's own name. */
function _segOf(p) {
  return String(p).slice(String(p).lastIndexOf('/') + 1);
}

/**
 * Name tokens: lowercased, non-alphanumeric split, short/stop words dropped.
 * "Booker-Coker, Telicia" -> ['booker','coker','telicia'].
 */
function _nameTokens(s) {
  const out = [];
  for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= RELINK_TOKEN_MIN && !NAME_STOPWORDS.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

/**
 * Every alphanumeric run in a folder's own name segment, as a Set.
 *
 * Deliberately NOT _nameTokens: nothing is dropped here. The name side is the
 * conjunctive one; making the segment side as permissive as possible only ever
 * helps a true match, while the matching RULE below is what keeps a false one
 * out.
 */
function _segTokens(seg) {
  return new Set(String(seg == null ? '' : seg).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Split an lfm_name ("Last, First Middle") into what a folder MUST carry to be
 * this client's folder, and what merely helps.
 *
 * ── WHY WHOLE-TOKEN EQUALITY AND NOT SUBSTRING ────────────────────────────
 * The first cut of this lane tested `segment.indexOf(token)`, and production
 * data caught it immediately:
 *
 *     "Jones, TIA"        matched " williams-jones, TIAnna ..."
 *     "Richardson, ANGEL" matched " richardson, ANGELa"
 *     "Miller, PHILLIP"   matched "... phillips v miller ..."
 *
 * Every one is a different client, and every one passed a rule that was
 * supposed to be the strict one. A given name is a whole word; testing it as
 * a substring re-opens exactly the collision the conjunctive rule closed.
 *
 * Note the asymmetry with the DOCKET lane, which stays a raw substring on
 * purpose: a docket is opaque and lives embedded inside longer folder names
 * ("...- 26-44475-mar - chapter 13"), so tokenising it would be the very
 * decomposition that is forbidden everywhere in this codebase. Names get
 * tokenised; dockets never do.
 *
 * ── WHY MIDDLE NAMES ARE OPTIONAL ─────────────────────────────────────────
 * Requiring EVERY token makes a middle name mandatory, so "Baker, Reginald"
 * would fail to match a case recorded as "Baker, Reginald Lindsay". The pair
 * that actually identifies a client is (surname, first given name) — it is
 * what separates Natasha Mitchell from Vinyanda Mitchell — so that is the bar.
 * Remaining tokens are still used, but only to rank.
 *
 * A name with no comma cannot be split, so every token is required: guessing
 * which half is the surname would be worse than being strict.
 */
function _nameKey(lfm) {
  const raw = String(lfm == null ? '' : lfm);
  const all = _nameTokens(raw);
  if (!all.length) return null;

  const comma = raw.indexOf(',');
  if (comma === -1) return { required: all, all, surname: all.slice(0, 1) };

  const surname = _nameTokens(raw.slice(0, comma));
  const given   = _nameTokens(raw.slice(comma + 1));
  if (!surname.length) return { required: all, all, surname: all.slice(0, 1) };

  const required = given.length ? [...surname, given[0]] : [...surname];
  return { required: [...new Set(required)], all, surname };
}

let _inventoryCache = null;   // { at, inv }

/** Test seam. The TTL is per-process, so a suite must be able to drop it. */
function _clearInventoryCache() { _inventoryCache = null; }

/**
 * Every directory that holds registered files, with TRANSITIVE counts.
 *
 * Transitive is the operative word and it follows from _matchCase: attribution
 * walks UP from a file, so linking a case to a PARENT folder attributes
 * everything beneath it. A count that only reported a folder's own immediate
 * files would understate what a confirm is about to surface — which is the one
 * number the human is being asked to judge.
 *
 * @returns {Promise<{files: Map<string,number>, newest: Map<string,*>, dirs: string[]}>}
 */
async function _buildFolderInventory(db, opts = {}) {
  const now = Date.now();
  if (!opts.noCache && _inventoryCache &&
      (now - _inventoryCache.at) < RELINK_INVENTORY_TTL_MS) {
    return _inventoryCache.inv;
  }

  // MySQL does the collapse; see the section header for why this shape is fine
  // where the correlated one is not.
  const [rows] = await db.query(
    `SELECT LEFT(path_lower,
                 LENGTH(path_lower) - LENGTH(SUBSTRING_INDEX(path_lower, '/', -1)) - 1) AS dir,
            COUNT(*)             AS files,
            MAX(server_modified) AS newest
       FROM documents
      WHERE status = 'active'
        AND path_lower IS NOT NULL
        AND path_lower <> ''
      GROUP BY dir`,
  );

  const files  = new Map();
  const newest = new Map();
  for (const r of rows) {
    const n  = Number(r.files) || 0;
    const nw = r.newest || null;
    let p = r.dir ? String(r.dir) : '';
    while (p && p.indexOf('/') !== -1) {
      files.set(p, (files.get(p) || 0) + n);
      if (nw && _ts(nw) > _ts(newest.get(p))) newest.set(p, nw);
      p = p.slice(0, p.lastIndexOf('/'));
    }
  }

  const inv = { files, newest, dirs: [...files.keys()], leaf_dirs: rows.length, built_at: now };
  _inventoryCache = { at: now, inv };
  return inv;
}

/**
 * Who owns which cached folder, and which folders sit ABOVE somebody's case.
 *
 * `owners` backs the exclusion in §2.4 and the 409 on confirm — a folder that
 * is already another case's is never offered with a confirm affordance and is
 * refused server-side if one is sent anyway.
 *
 * `under` backs type-level detection AND the nesting warning: a candidate that
 * has another case's folder inside it is not automatically wrong (attribution
 * resolves to the innermost match, so the nested case keeps its own documents)
 * but it is something the human confirming must be told.
 */
async function _loadFolderOwners(db) {
  const [rows] = await db.query(
    `SELECT case_id, path_lower
       FROM case_folder_cache
      WHERE path_lower IS NOT NULL AND path_lower <> ''`,
  );

  const owners = new Map();   // path  -> Set(case_id)
  const under  = new Map();   // ancestor path -> Set(case_id) strictly beneath

  for (const r of rows) {
    const p  = String(r.path_lower);
    const id = String(r.case_id);
    if (!owners.has(p)) owners.set(p, new Set());
    owners.get(p).add(id);

    let q = p;
    while (q && q.indexOf('/') !== -1) {
      q = q.slice(0, q.lastIndexOf('/'));
      if (!q) break;
      if (!under.has(q)) under.set(q, new Set());
      under.get(q).add(id);
    }
  }
  return { owners, under, size: rows.length };
}

/**
 * Is this folder a TYPE level (or a root) rather than a case folder?
 *
 * Derived from the data, not from a hardcoded depth — and it has to be, because
 * cached case folders sit at four different depths in production (4, 5, 6 and
 * 7 segments) depending on which tree they live in. Depth is not the signal;
 * "how many cases live underneath me" is.
 */
function _isTypeLevel(pathLower, rootSet, under) {
  if (rootSet.has(pathLower)) return true;
  const s = under.get(pathLower);
  return !!s && s.size >= TYPE_LEVEL_MIN_CASES;
}

/**
 * The nearest ancestor of `pathLower` that is ANOTHER case's cached folder.
 * Same upward walk as _matchCase, so it answers the question the attribution
 * engine would answer: "whose folder is this sitting inside?"
 */
function _nearestOwnedAncestor(pathLower, owners, selfId) {
  let p = String(pathLower);
  while (p && p.indexOf('/') !== -1) {
    p = p.slice(0, p.lastIndexOf('/'));
    if (!p) break;
    const hit = owners.get(p);
    if (hit) {
      const other = [...hit].filter(id => id !== String(selfId));
      if (other.length) return other.sort()[0];
    }
  }
  return null;
}

/**
 * Walk up from `pathLower` and return the SHALLOWEST still-under-a-root
 * directory whose own segment satisfies `test`, or null.
 *
 * This is what makes the lanes depth-agnostic. Given
 *   ".../ 13 - armstrong, jordan - 26-44475-mar - chapter 13/docket - jordan armstrong/x.pdf"
 * the token "armstrong" appears in TWO directory segments; the case folder is
 * the shallower one, and picking it means a confirm attributes the subfolders
 * too rather than just one of them.
 */
function _shallowestSegmentMatch(pathLower, rootLowers, test) {
  let best = null;
  let p = String(pathLower);
  while (p && p.indexOf('/') !== -1) {
    // Strictly BELOW a root: a root itself is never a candidate.
    if (!rootLowers.some(r => p !== r && _underRoot(p, r))) break;
    if (test(_segOf(p))) best = p;
    p = p.slice(0, p.lastIndexOf('/'));
  }
  return best;
}

/**
 * Everything the ranking needs that does not vary per case. Built ONCE per
 * request and handed to every case in the batch.
 */
async function _relinkContext(db, opts = {}) {
  const [inv, ownersIdx, rootLowers] = await Promise.all([
    _buildFolderInventory(db, opts),
    _loadFolderOwners(db),
    _loadEnabledRootPaths(db),
  ]);

  // ── TOKENISE ONCE, INVERT ONCE ──────────────────────────────────────────
  // The name lane needs a Set of tokens per folder segment. Building that
  // inside the per-case loop meant 418 cases x 8,423 directories x one split()
  // = ~3.5M tokenisations and a 3.1-second queue load, measured. Doing it here
  // makes it 8,423 — the work does not depend on the case, so it does not
  // belong in the case loop.
  //
  // The inverted index then removes the scan itself: a case looks up its
  // surname and gets the handful of directories that could possibly match,
  // instead of walking every directory in the estate. The DOCKET lane keeps
  // its linear scan on purpose — it is a substring test, not a token test, so
  // it cannot use a token index, and only a handful of cases carry a docket.
  const segTokens = new Map();   // dir   -> Set(token)
  const byToken   = new Map();   // token -> dir[]
  for (const dir of inv.dirs) {
    const toks = _segTokens(_segOf(dir));
    segTokens.set(dir, toks);
    for (const t of toks) {
      let list = byToken.get(t);
      if (!list) { list = []; byToken.set(t, list); }
      list.push(dir);
    }
  }

  return {
    inv,
    owners: ownersIdx.owners,
    under: ownersIdx.under,
    rootLowers,
    rootSet: new Set(rootLowers),
    segTokens,
    byToken,
  };
}

/**
 * Rank candidate folders for ONE case against a prebuilt context.
 *
 * Lanes, in confidence order:
 *
 *   docket — the case's case_number_full / case_number appears in the folder's
 *            own name segment as an OPAQUE case-insensitive substring. Not a
 *            parse. Nothing anywhere in this file splits a docket into year,
 *            judge or sequence, and the test suite asserts that it never does.
 *   name   — EVERY token of a related contact's lfm_name appears in the
 *            segment. See the section header for the measurement that made
 *            this conjunctive rather than ranked-by-overlap.
 *   weak   — the SURNAME appears but the given name does not. Withheld unless
 *            the caller asks; the UI hides it behind a toggle and a second
 *            checkbox. Included at all only because the pre-template legacy
 *            trees ("  Closed Files") contain hand-made folders that a
 *            conjunctive rule cannot reach.
 */
function _rankCandidates(ctx, caseRow, contacts, opts = {}) {
  const includeWeak = !!opts.includeWeak;
  const caseId = String(caseRow.case_id);
  const { inv, owners, under, rootLowers, rootSet, segTokens, byToken } = ctx;
  const tokensOf = dir => segTokens.get(dir) || _segTokens(_segOf(dir));

  const found = new Map();   // path -> { confidence, matched_on }
  const place = (path, confidence, matchedOn) => {
    if (!path) return;
    if (_isTypeLevel(path, rootSet, under)) return;
    const prior = found.get(path);
    const rank = c => (c === 'docket' ? 0 : c === 'name' ? 1 : 2);
    if (!prior || rank(confidence) < rank(prior.confidence)) {
      found.set(path, { confidence, matched_on: matchedOn });
    }
  };

  // ── docket lane ─────────────────────────────────────────────────────────
  const dockets = [];
  for (const k of ['case_number_full', 'case_number']) {
    const v = String(caseRow[k] == null ? '' : caseRow[k]).trim().toLowerCase();
    if (v.length >= RELINK_TOKEN_MIN && !dockets.includes(v)) dockets.push(v);
  }
  for (const tok of dockets) {
    for (const dir of inv.dirs) {
      if (_segOf(dir).indexOf(tok) === -1) continue;
      place(_shallowestSegmentMatch(dir, rootLowers, seg => seg.indexOf(tok) !== -1),
            'docket', tok);
    }
  }

  // ── name lanes ──────────────────────────────────────────────────────────
  // WHOLE-TOKEN equality on both sides — see _nameKey for the production
  // false positives that rule exists to stop.
  for (const ct of contacts) {
    const key = _nameKey(ct.contact_lfm_name);
    if (!key) continue;
    const hasAll = (set, toks) => toks.every(t => set.has(t));
    const strong = key.required.length >= 2;

    // Start from the rarest surname token's posting list rather than the whole
    // estate; every candidate must contain ALL surname tokens anyway, so any
    // one of them is a sound entry point.
    const seed = key.surname
      .map(t => byToken.get(t) || [])
      .reduce((a, b) => (a && a.length <= b.length ? a : b), null) || [];

    for (const dir of seed) {
      const segSet = tokensOf(dir);
      if (!hasAll(segSet, key.surname)) continue;

      if (strong && hasAll(segSet, key.required)) {
        place(_shallowestSegmentMatch(dir, rootLowers,
                s => hasAll(_segTokens(s), key.required)),
              'name', ct.contact_lfm_name);
      } else if (includeWeak) {
        place(_shallowestSegmentMatch(dir, rootLowers,
                s => hasAll(_segTokens(s), key.surname)),
              'weak', key.surname.join(' '));
      }
    }
  }

  const out = [];
  for (const [path, meta] of found) {
    const holders = [...(owners.get(path) || [])].filter(id => id !== caseId);
    const nested  = [...(under.get(path)  || [])].filter(id => id !== caseId);
    // The nearest ANCESTOR that is somebody else's case folder. Production
    // shape: "... 7 - gardin, alicia - 25-41340 - chapter 7/ client docs -
    // dennis gardin and alicia gardin" is a legitimate token match for Dennis
    // Gardin AND a subfolder of Alicia Gardin's case. Joint debtors make that
    // plausibly right, which is exactly why it must be DISCLOSED rather than
    // silently ranked — the person confirming is the only one who knows.
    const insideOf = _nearestOwnedAncestor(path, owners, caseId);
    out.push({
      path,
      files: inv.files.get(path) || 0,
      newest: inv.newest.get(path) || null,
      confidence: meta.confidence,
      matched_on: meta.matched_on,
      inside_case_id: insideOf,
      // §2.4: SURFACED, never confirmable. Seeing the collision is the useful
      // part; being able to click through it is the confidentiality bug.
      already_linked_to: holders.length ? holders.sort() : null,
      // Not an error — attribution resolves innermost-first, so the nested
      // case keeps its own files. It is disclosed because the human is being
      // asked whether this pairing is right.
      nested_case_ids: nested.length ? nested.sort() : null,
    });
  }

  const rank = c => (c === 'docket' ? 0 : c === 'name' ? 1 : 2);
  out.sort((a, b) =>
    rank(a.confidence) - rank(b.confidence) ||
    (a.already_linked_to ? 1 : 0) - (b.already_linked_to ? 1 : 0) ||
    b.files - a.files ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const truncated = out.length > RELINK_CANDIDATE_CAP;
  return { candidates: out.slice(0, RELINK_CANDIDATE_CAP), candidates_truncated: truncated };
}

/**
 * Rank candidates for MANY cases in one pass.
 *
 * Three batched reads plus one shared context, rather than three reads per
 * case: the panel asks about the whole queue at once, and 418 cases through a
 * per-case path would be 1,254 round trips.
 */
async function relinkCandidatesBatch(db, caseIds, opts = {}) {
  const ids = [...new Set((caseIds || []).map(v => String(v)).filter(Boolean))]
    .slice(0, RELINK_BATCH_CAP);
  const out = new Map();
  if (!ids.length) return out;

  const [caseRows] = await db.query(
    `SELECT case_id, case_number, case_number_full, case_dropbox,
            case_stage, pipeline_phase, case_type, case_subtype
       FROM cases
      WHERE case_id IN (?)`,
    [ids],
  );

  const [contactRows] = await db.query(
    `SELECT cr.case_relate_case_id AS case_id,
            ct.contact_name, ct.contact_lfm_name,
            cr.case_relate_type    AS rel
       FROM case_relate cr
       JOIN contacts ct ON ct.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id IN (?)
        AND cr.case_relate_type IN (?)
      ORDER BY (cr.case_relate_type = 'Primary') DESC, cr.case_relate_client_id ASC`,
    [ids, RELINK_RELATE_TYPES],
  );

  const [cacheRows] = await db.query(
    `SELECT case_id, path_lower, path_display, resolved_at, resolve_error,
            relink_dismissed_at, relink_dismissed_by
       FROM case_folder_cache
      WHERE case_id IN (?)`,
    [ids],
  );

  const contactsByCase = new Map();
  for (const r of contactRows) {
    const k = String(r.case_id);
    if (!contactsByCase.has(k)) contactsByCase.set(k, []);
    const list = contactsByCase.get(k);
    if (list.length < RELINK_CONTACT_CAP) list.push(r);
  }
  const cacheByCase = new Map(cacheRows.map(r => [String(r.case_id), r]));

  const ctx = await _relinkContext(db, opts);

  for (const row of caseRows) {
    const k = String(row.case_id);
    const cached = cacheByCase.get(k) || null;
    const contacts = contactsByCase.get(k) || [];
    const ranked = _rankCandidates(ctx, row, contacts, opts);
    const actionable = ranked.candidates.some(c => !c.already_linked_to);

    out.set(k, {
      case_id: k,
      case_number: row.case_number || null,
      case_number_full: row.case_number_full || null,
      case_stage: row.case_stage || null,
      pipeline_phase: row.pipeline_phase || null,
      // What staff are moving AWAY from. The stale intake link, said plainly.
      current_path: cached ? (cached.path_lower || null) : null,
      current_path_display: cached ? (cached.path_display || null) : null,
      current_link: row.case_dropbox || null,
      resolve_error: cached ? (cached.resolve_error || null) : null,
      dismissed_at: cached ? (cached.relink_dismissed_at || null) : null,
      dismissed_by: cached ? (cached.relink_dismissed_by ?? null) : null,
      client_names: contacts.map(c => c.contact_lfm_name).filter(Boolean),
      actionable,
      ...ranked,
    });
  }
  return out;
}

/** One case. Delegates, so the single and batch paths cannot disagree. */
async function relinkCandidates(db, caseId, opts = {}) {
  const map = await relinkCandidatesBatch(db, [caseId], opts);
  return map.get(String(caseId)) || null;
}

/**
 * The re-link queue: every case whose folder resolved cleanly and that holds
 * NO attributed documents, with a label and its dismissal state.
 *
 * ── WHY THIS IS NOT READ OUT OF THE ATTRIBUTION REPORT ────────────────────
 * The charter named documents_attribution_report as the queue source. It
 * cannot be: that report's `sample` lists only cases carrying RESIDUE, and
 * production residue for this population is exactly zero (all 418 intake
 * folders are empty). The report therefore knows the COUNT and names none of
 * the cases. This runs the report's own cheap head query — the one measured at
 * 77ms over 986 cached folders against idx_dl_target — and returns the ids.
 *
 * Read-only. Writes nothing, resolves nothing, calls no provider.
 */
async function relinkQueue(db, opts = {}) {
  const includeDismissed = !!opts.includeDismissed;

  const [rows] = await db.query(
    `SELECT f.case_id, f.path_lower, f.path_display, f.resolved_at,
            f.relink_dismissed_at, f.relink_dismissed_by
       FROM case_folder_cache f
       LEFT JOIN document_links dl
         ON dl.link_type = 'case' AND dl.link_id = f.case_id
      WHERE f.path_lower IS NOT NULL AND f.path_lower <> ''
        AND dl.id IS NULL`,
  );

  const visible = includeDismissed ? rows : rows.filter(r => !r.relink_dismissed_at);
  const ids = visible.map(r => String(r.case_id));

  const detail = opts.withCandidates === false
    ? new Map()
    : await relinkCandidatesBatch(db, ids, opts);

  const cases = visible.map((r) => {
    const d = detail.get(String(r.case_id));
    return d || {
      case_id: String(r.case_id),
      current_path: r.path_lower || null,
      current_path_display: r.path_display || null,
      dismissed_at: r.relink_dismissed_at || null,
      dismissed_by: r.relink_dismissed_by ?? null,
      candidates: [], candidates_truncated: false, actionable: false,
      client_names: [],
    };
  });

  const actionable = cases.filter(c => c.actionable).length;
  return {
    total: rows.length,
    dismissed: rows.filter(r => !!r.relink_dismissed_at).length,
    shown: cases.length,
    actionable,
    no_candidate: cases.length - actionable,
    truncated: ids.length > RELINK_BATCH_CAP,
    cases,
  };
}

/**
 * Stamp (or clear) the dismissal columns.
 *
 * ── WHY BULK IS SAFE HERE AND NOWHERE ELSE IN THIS SECTION ────────────────
 * Dismissal writes two columns on case_folder_cache. It changes no
 * document_link, no cases row, and touches no provider — it is a note on the
 * queue, not an assertion about a document. The ONE RULE governs LINK changes;
 * this is not one. Given that ~394 of the 418 have no candidate to confirm,
 * making each of them an individual click would not be caution, it would be
 * make-work that guarantees the queue is never cleared and therefore never
 * watched.
 *
 * A plain UPDATE, not an upsert: the queue is DERIVED from case_folder_cache,
 * so the row always exists. Inserting one would mean inventing a cache row
 * with no path and a fictional resolved_at.
 */
async function setRelinkDismissed(db, caseIds, opts = {}) {
  const dismissed = opts.dismissed !== false;
  const ids = [...new Set((caseIds || []).map(v => String(v)).filter(Boolean))]
    .slice(0, RELINK_DISMISS_CAP);
  if (!ids.length) return { updated: 0, case_ids: [], dismissed };

  const [res] = await db.query(
    `UPDATE case_folder_cache
        SET relink_dismissed_at = ${dismissed ? 'NOW()' : 'NULL'},
            relink_dismissed_by = ?
      WHERE case_id IN (?)`,
    [dismissed ? (opts.actorUserId ?? null) : null, ids],
  );

  return { updated: res ? res.affectedRows : 0, case_ids: ids, dismissed };
}

/**
 * Attribute the documents under a just-confirmed folder to the case, NOW.
 *
 * ── ENGINE PARITY IS THE CORRECTNESS ARGUMENT ─────────────────────────────
 * This does NOT link everything matching the prefix. It links what
 * attributeUnlinked would have linked on its next lap: rows under the folder
 * whose INNERMOST cached-folder match is this case, tested with the same
 * _matchCase walk. The difference is not academic. If the confirmed folder
 * happens to contain another case's cached folder, a naive prefix sweep would
 * pull that case's documents onto this one — the exact leak this slice exists
 * to prevent — while _matchCase resolves them to their own case and leaves
 * them alone.
 *
 * ── SILENT, AND WHY THAT IS RIGHT RATHER THAN CONVENIENT ──────────────────
 * This is backfill-shaped work, not event-shaped. One confirm can attribute
 * several hundred documents (377 in the largest production candidate); firing
 * document.linked for each would run the trigger engine hundreds of times for
 * files that have been sitting in Dropbox for years. Same reasoning, same
 * mechanism (documents.bulkLink), and the same accepted gap the file header
 * already documents for the sweep.
 *
 * ADD-ONLY. The anti-join skips any row that already holds a path-link, so a
 * document a person filed elsewhere, and a document the move reconciler
 * already ruled on, are both left exactly as they are.
 */
async function _attributeUnderFolder(db, caseId, folderLower, cache) {
  const [rows] = await db.query(
    `SELECT d.id, d.path_lower
       FROM documents d
       LEFT JOIN document_links dl
         ON dl.document_id = d.id
        AND dl.link_type = 'case'
        AND dl.relation = ?
      WHERE d.status = 'active'
        AND d.path_lower IS NOT NULL
        AND d.path_lower LIKE ? ESCAPE '|'
        AND dl.id IS NULL
      ORDER BY d.id
      LIMIT ${RELINK_ATTRIBUTION_CAP}`,
    [documents.RELATION_PATH, _likeEscape(folderLower) + '/%'],
  );

  const links = [];
  for (const r of rows) {
    const hit = _matchCase(cache.byPath, r.path_lower);
    if (hit && String(hit.case_id) === String(caseId)) {
      links.push({
        document_id: r.id, link_type: 'case', link_id: caseId,
        relation: documents.RELATION_PATH,
      });
    }
  }
  if (links.length) await documents.bulkLink(db, links);

  return {
    scanned: rows.length,
    linked: links.length,
    truncated: rows.length >= RELINK_ATTRIBUTION_CAP,
  };
}

/**
 * THE CONFIRM. A human has chosen a specific folder for a specific case.
 *
 * Order is load-bearing:
 *   1. re-run the cross-link guard SERVER-SIDE (the UI grey-out is not it)
 *   2. prove the folder is real
 *   3. mint the permanent shared link
 *   4. rewrite cases.case_dropbox through caseService (house write path)
 *   5. refresh THIS case's folder cache, targeted
 *   6. attribute what is under it, silently, with engine parity
 *   7. clear any dismissal, and write the audit entry
 *
 * Steps 4 and 5 cannot swap: the cache resolves the SHARED LINK, so it has to
 * read the new one. Steps 5 and 6 cannot swap either: attribution matches
 * against the cache, so it has to see the new path.
 *
 * @returns {Promise<object>} what changed, plus any warnings worth surfacing
 */
async function applyRelink(db, caseId, folderPath, opts = {}) {
  const caseService = require('./caseService');   // lazy require (convention)
  const logService  = require('./logService');    // lazy require (convention)

  const actorUserId = opts.actorUserId ?? null;
  const credOpt = opts.credentialId != null ? { credentialId: opts.credentialId } : {};
  const startedAt = Date.now();
  const warnings = [];

  const raw = String(folderPath == null ? '' : folderPath);
  if (!raw.trim()) {
    const e = new Error('folder_path is required'); e.status = 400; throw e;
  }
  if (!raw.startsWith('/')) {
    const e = new Error('folder_path must be a full Dropbox path starting with "/"');
    e.status = 400; throw e;
  }
  const path  = dropbox.normalizePath(raw);
  const lower = String(path).toLowerCase();
  if (!lower) {
    const e = new Error('the Dropbox account root cannot be a case folder');
    e.status = 400; throw e;
  }

  const [[caseRow]] = await db.query(
    'SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [caseId],
  );
  if (!caseRow) {
    const e = new Error(`Case ${caseId} not found`); e.status = 404; throw e;
  }

  const [[priorCache]] = await db.query(
    'SELECT path_lower FROM case_folder_cache WHERE case_id = ? LIMIT 1', [caseId],
  );
  const oldPath = priorCache ? (priorCache.path_lower || null) : null;

  // A folder no root walks would leave the case looking repaired while its
  // documents stayed unregistered forever — the failure out_of_root exists to
  // report, arrived at deliberately.
  const rootLowers = await _loadEnabledRootPaths(db);
  if (!rootLowers.some(r => lower !== r && _underRoot(lower, r))) {
    const e = new Error(
      'that folder is not under any enabled sync root, so its documents would ' +
      'never be registered — add a root for it first, or pick a folder inside one');
    e.status = 400; throw e;
  }

  // ── 1. THE GUARD, RE-RUN HERE ───────────────────────────────────────────
  // The greyed-out row in the panel is a courtesy; THIS is the control. Two
  // staffers confirming the same folder for different cases within the same
  // second is a TOCTOU window this re-check narrows but does not close — the
  // second write would need a unique index on path_lower to be impossible, and
  // that index cannot exist because two cases legitimately CAN share a folder
  // in the legacy trees. Narrowing is the right amount of engineering here;
  // the audit log names who did what if it ever happens.
  const { owners, under } = await _loadFolderOwners(db);
  const holders = [...(owners.get(lower) || [])].filter(id => id !== String(caseId));
  if (holders.length) {
    const e = new Error(
      `that folder is already linked to case ${holders.join(', ')} — ` +
      'linking it here as well would put both clients\' documents on both cases');
    e.status = 409; throw e;
  }

  const nested = [...(under.get(lower) || [])].filter(id => id !== String(caseId));
  if (nested.length) {
    warnings.push(
      `${nested.length} other case folder${nested.length === 1 ? '' : 's'} ` +
      `(${nested.join(', ')}) sit inside this one; their documents stay on their own cases`);
  }

  // ── 2. IS IT REAL ───────────────────────────────────────────────────────
  // Registered files are the cheap proof and cover every candidate the panel
  // offers. The provider stat is the fallback for a folder a person typed in
  // that legitimately has nothing in it yet.
  const inv = await _buildFolderInventory(db, { noCache: true });
  const knownFiles = inv.files.get(lower) || 0;
  if (!knownFiles) {
    let meta = null;
    try {
      meta = await dropbox.getMetadata(db, { path, ...credOpt });
    } catch (err) {
      if (dropbox.isPathNotFoundError(err)) {
        const e = new Error(`no such folder in Dropbox: ${path}`); e.status = 404; throw e;
      }
      throw err;
    }
    if (meta && meta['.tag'] === 'file') {
      const e = new Error('that path is a file — a case folder must be a folder');
      e.status = 400; throw e;
    }
    warnings.push('that folder holds no registered documents yet');
  }

  // ── 3. MINT ─────────────────────────────────────────────────────────────
  // The second sanctioned place a permanent shared link is created, and the
  // only one that mints one for a FOLDER — /api/documents/:id/share mints them
  // for documents. This mirrors exactly what intake minted originally, which
  // is what makes the resulting case_dropbox indistinguishable from a
  // correctly-created one to everything downstream.
  const sharedLink = await dropbox.getOrCreateSharedLink(db, { path, ...credOpt });
  if (!sharedLink) {
    const e = new Error('Dropbox returned no shared link for that folder');
    e.status = 502; throw e;
  }
  // REJECTED, NOT CLAMPED — the same rule _validateRootPath states for a root
  // path, for the same reason: a truncated URL is not a shortened label, it is
  // a link that resolves to nothing, and this DB has no STRICT_TRANS_TABLES to
  // catch it.
  if (String(sharedLink).length > CASE_DROPBOX_MAX) {
    const e = new Error(
      `the shared link is ${String(sharedLink).length} characters; ` +
      `cases.case_dropbox holds ${CASE_DROPBOX_MAX}. Refusing to store a truncated link.`);
    e.status = 500; throw e;
  }

  // ── 4. THE HOUSE WRITE PATH ─────────────────────────────────────────────
  // Not a raw UPDATE from here: updateCase owns the blank-date normalisation,
  // the note-length guard and the case.updated emission with a real actor.
  // Re-pointing a case's Dropbox folder is exactly the kind of change a rule
  // author may want to see.
  await caseService.updateCase(db, caseId, { case_dropbox: sharedLink }, {
    userId: actorUserId,
    source: 'documents_relink',
  });

  // ── 5. TARGETED REFRESH ─────────────────────────────────────────────────
  const cacheResult = await refreshCaseFolderCache(db, { caseIds: [caseId], ...credOpt });
  const [[freshCache]] = await db.query(
    'SELECT path_lower FROM case_folder_cache WHERE case_id = ? LIMIT 1', [caseId],
  );
  const resolved = freshCache && freshCache.path_lower ? String(freshCache.path_lower) : null;

  if (!resolved || resolved !== lower) {
    // Either the resolve failed (prior path survives, by design) or Dropbox
    // reported a different path than the one asked for. Both are reportable
    // rather than fatal: the link IS updated and the recurring cache job will
    // settle it. Saying so beats a silent "0 documents linked".
    warnings.push(resolved
      ? `Dropbox resolved the new link to "${resolved}"`
      : 'the folder cache did not refresh — documents will attach on the next cache run');
  }

  // ── 6. ATTRIBUTE ────────────────────────────────────────────────────────
  let attribution = { scanned: 0, linked: 0, truncated: false };
  if (resolved) {
    const cache = await _loadCaseFolderCache(db);
    attribution = await _attributeUnderFolder(db, caseId, resolved, cache);
  }
  if (attribution.truncated) {
    warnings.push(
      `only the first ${RELINK_ATTRIBUTION_CAP} documents under the folder were ` +
      'considered; the recurring sweep will pick up the rest');
  }

  // ── 7. UNDISMISS + AUDIT ────────────────────────────────────────────────
  await db.query(
    `UPDATE case_folder_cache
        SET relink_dismissed_at = NULL, relink_dismissed_by = NULL
      WHERE case_id = ?`,
    [caseId],
  );

  // House log conventions, matched to caseService.mergeCases: type 'update',
  // link_type 'case', a one-line subject, a prose message, and the machine
  // readable form in log_extra. This is the change that gets audited later —
  // "who moved this case's folder, from where, to where, and what appeared".
  try {
    await logService.createLogEntry(db, {
      type: 'update',
      link_type: 'case',
      link_id: caseId,
      by: actorUserId ?? 0,
      subject: 'Case Dropbox folder re-linked',
      message:
        `Re-linked the case's Dropbox folder from "${oldPath || '(none cached)'}" ` +
        `to "${resolved || lower}". ${attribution.linked} document` +
        `${attribution.linked === 1 ? '' : 's'} attributed.` +
        (warnings.length ? ` Notes: ${warnings.join('; ')}.` : ''),
      extra: {
        relink: {
          old_path: oldPath,
          old_link: caseRow.case_dropbox || null,
          new_path: resolved || lower,
          requested_path: path,
          new_link: sharedLink,
          linked_docs: attribution.linked,
          scanned_docs: attribution.scanned,
          nested_case_ids: nested,
          warnings,
        },
      },
    });
  } catch (err) {
    // The link is already changed and the documents are already attributed.
    // Losing the audit line is bad; unwinding a correct repair because the log
    // write failed would be worse, and there is no transaction spanning a
    // Dropbox call anyway.
    console.error('[documents.relink] audit log write failed:', err.message);
    warnings.push('the audit log entry could not be written');
  }

  return {
    case_id: String(caseId),
    old_path: oldPath,
    new_path: resolved || lower,
    requested_path: path,
    shared_link: sharedLink,
    linked_docs: attribution.linked,
    scanned_docs: attribution.scanned,
    cache: cacheResult,
    warnings,
    elapsed_ms: Date.now() - startedAt,
  };
}

module.exports = {
  refreshCaseFolderCache,
  attributionReport,
  syncRoot,
  syncAll,
  attributeUnlinked,
  // S3.2 — roots admin + diagnostics
  listRoots,
  getRoot,
  getRootRaw,
  addRoot,
  setRootEnabled,
  isSyncEnabled,
  latestJobReports,
  // S3.3 — guided re-link
  relinkQueue,
  relinkCandidates,
  relinkCandidatesBatch,
  applyRelink,
  setRelinkDismissed,
  // exported for tests / reuse
  _matchCase,
  _underRoot,
  _loadCaseFolderCache,
  _validateRootPath,
  _findNestingConflict,
  CLAIM_STALE_MIN,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_CACHE_RUNTIME_MS,
  DEFAULT_REPORT_RUNTIME_MS,
  DIAGNOSTIC_FUNCTIONS,
  ROOT_PATH_MAX,
  ROOT_NOTE_MAX,
  SWEEP_WATERMARK_KEY,
  _buildFolderInventory,
  _loadFolderOwners,
  _clearInventoryCache,
  _nameTokens,
  _nameKey,
  _segTokens,
  _nearestOwnedAncestor,
  _shallowestSegmentMatch,
  _isTypeLevel,
  _rankCandidates,
  _likeEscape,
  RELINK_CANDIDATE_CAP,
  RELINK_DISMISS_CAP,
  RELINK_BATCH_CAP,
  RELINK_ATTRIBUTION_CAP,
  TYPE_LEVEL_MIN_CASES,
  CASE_DROPBOX_MAX,
};
