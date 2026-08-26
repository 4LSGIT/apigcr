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
 * ── ONE CURSOR, TWO MODES ─────────────────────────────────────────────────
 * Dropbox's list_folder cursor does double duty: paging THROUGH the initial
 * listing, and then delta-ing FROM it. This engine reads the mode off cursor
 * PRESENCE rather than storing a mode flag:
 *
 *     sync_cursor IS NULL   →  BACKFILL     — emissions OFF, bulk writes
 *     sync_cursor IS NOT NULL → INCREMENTAL — emissions ON, per-row writes
 *
 * That is not a shortcut, it is the recovery mechanism. When Dropbox
 * invalidates a cursor (409 `reset`) the ONLY fix is to re-list the whole
 * subtree — which means re-walking 26,000 files through a path that must not
 * emit 26,000 events. Clearing the cursor puts the engine back in backfill
 * mode automatically, so a forced re-list cannot storm the trigger engine.
 * A stored mode flag would have to be reset in the same breath and would
 * eventually not be.
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
 * @param {object} db
 * @param {object} [opts] — { limit=300, credentialId? }
 * @returns {Promise<{resolved:number, failed:number, out_of_root:string[], ...}>}
 */
async function refreshCaseFolderCache(db, opts = {}) {
  const limit = Math.min(_int(opts.limit, 300), 2000);
  const credentialId = opts.credentialId ?? null;
  const startedAt = Date.now();

  // Oldest-first; rows absent from the cache sort ahead of every resolved one.
  const [cases] = await db.query(
    `SELECT c.case_id, c.case_dropbox
       FROM cases c
       LEFT JOIN case_folder_cache f ON f.case_id = c.case_id
      WHERE c.case_dropbox IS NOT NULL AND c.case_dropbox <> ''
      ORDER BY (f.resolved_at IS NULL) DESC, f.resolved_at ASC
      LIMIT ${limit}`,
  );

  const rootPaths = await _loadEnabledRootPaths(db);

  let resolved = 0;
  let failed   = 0;
  const outOfRoot = [];
  const failures  = [];

  for (const c of cases) {
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
    scanned: cases.length,
    limit,
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

  const backfill = !root.sync_cursor;
  const mode = backfill ? 'backfill' : 'incremental';
  let cursor = root.sync_cursor || null;

  const cache = opts.cache || await _loadCaseFolderCache(db);

  let pages = 0, files = 0, linked = 0, deletedRows = 0, folderHeals = 0;
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
          await db.query(
            `UPDATE document_sync_roots
                SET sync_cursor = NULL, last_error = ?, syncing_since = NULL
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
              if (found) links.push({ document_id: found.id, link_type: 'case', link_id: m.case_id });
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
            const { row } = await documents.upsertFromEntry(db, SOURCE, e, {
              emit: true, eventSource: 'system',
            });
            const hit = _matchCase(cache.byPath, e.path_lower);
            if (hit && row) {
              // link() emits document.linked for a genuinely NEW link only —
              // idempotent and silent on a repeat, which is exactly S1's
              // contract and what makes re-processing a page safe.
              const r = await documents.link(db, row.id, 'case', hit.case_id, {
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

      if (!page.has_more) { stopReason = 'complete'; break; }
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
    folder_heals: folderHeals, stop: stopReason, ms: Date.now() - startedAt,
  };
  await db.query(
    `UPDATE document_sync_roots
        SET last_sync_at = NOW(), last_error = NULL, stats = ?, syncing_since = NULL
      WHERE id = ?`,
    [JSON.stringify(stats), root.id],
  );

  return { root_id: root.id, path: root.path, ...stats };
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
 * Link active documents that have NO case link but whose path now matches a
 * cached case folder. SILENT — always, unconditionally.
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
 * ── THE STEADY-STATE COST ─────────────────────────────────────────────────
 * The anti-join re-tests every genuinely case-less document on every run —
 * files under the "Unsorted …" roots, loose firm documents, anything whose
 * case has no Dropbox folder. That set does not shrink, so this query's cost
 * is a floor, not a decaying tail. It is bounded by `limit` and driven by
 * uq_doc_target (document_id, link_type, link_id) as the join index.
 * REVISIT THRESHOLD: if the permanently-unlinked population passes ~20k, or
 * this query starts showing up in slow logs, add a `case_link_checked_at`
 * column (or a negative-cache table) so a document is only re-tested after
 * the cache actually changes. Do not just raise the limit.
 *
 * @param {object} db
 * @param {object} [opts] — { limit=5000 }
 * @returns {Promise<{scanned:number, linked:number, limit:number, elapsed_ms:number}>}
 */
async function attributeUnlinked(db, opts = {}) {
  const limit = Math.min(_int(opts.limit, 5000), 50000);
  const startedAt = Date.now();

  const cache = opts.cache || await _loadCaseFolderCache(db);
  if (!cache.size) return { scanned: 0, linked: 0, limit, elapsed_ms: Date.now() - startedAt };

  const [rows] = await db.query(
    `SELECT d.id, d.path_lower
       FROM documents d
       LEFT JOIN document_links dl
         ON dl.document_id = d.id AND dl.link_type = 'case'
      WHERE d.status = 'active'
        AND d.path_lower IS NOT NULL
        AND dl.id IS NULL
      LIMIT ${limit}`,
  );

  const links = [];
  for (const r of rows) {
    const hit = _matchCase(cache.byPath, r.path_lower);
    if (hit) links.push({ document_id: r.id, link_type: 'case', link_id: hit.case_id });
  }

  if (links.length) await documents.bulkLink(db, links);

  return { scanned: rows.length, linked: links.length, limit, elapsed_ms: Date.now() - startedAt };
}

module.exports = {
  refreshCaseFolderCache,
  syncRoot,
  syncAll,
  attributeUnlinked,
  // exported for tests / reuse
  _matchCase,
  _underRoot,
  _loadCaseFolderCache,
  CLAIM_STALE_MIN,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RUNTIME_MS,
};
