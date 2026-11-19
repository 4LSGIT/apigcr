// services/clientUploadBatchService.js
//
/**
 * CLIENT UPLOAD BATCHES — per-file reporting + lost-batch recovery for the two
 * upload pages (docs intake S3, 2026-11-19).
 *
 *   docreq   public/docReq.html        → POST /api/public/upload-landed        (routes/api.checklists.js)
 *   portal   public/portal/docs.html   → POST /api/portal/cases/:id/docs/upload-landed (portalDocsService.recordLanded)
 *
 * WHY: both pages PUT each file straight to Dropbox, then send ONE
 * upload-complete naming what made it. A tab or phone closed mid-batch sent
 * nothing — no notice, no `docs` log row (Turner, 2026-07-28: four files
 * incl. the 2025 tax return, found by a Dropbox listing in November). The email
 * doors have no such gap: the server holds the bytes.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 * The page mints a batch key per upload run and reports each file as it lands
 * (fetch keepalive — a closing tab still delivers it): landed() appends it to
 * the run's client_upload_batches row. The SERVER owns closure:
 *
 *   finishByClient   the page's final upload-complete (with the key):
 *                    closeByClient merges its list with the landed one and
 *                    claims the row → the completion phase runs once →
 *                    markNotified.
 *   sweepLostBatches the /process-jobs tick's housekeeping: a row nobody closed,
 *                    quiet QUIET_MIN after its last file, is claimed and
 *                    completed on what landed — the notice says the page closed
 *                    early (closedBy 'sweep'). Same sweep: a row the page closed
 *                    whose completion never finished (the instance died after
 *                    the 200) is retried once its claim is stale.
 *
 * EXACTLY ONE COMPLETION PER ROW. Both paths take the row lock (the close a
 * plain FOR UPDATE, the sweep FOR UPDATE SKIP LOCKED by primary key) and both
 * stamp claimed_at; neither takes a row the other holds a fresh claim on;
 * notified_at is the done-stamp. The sweep sets closed_at AT CLAIM, so a landed
 * call arriving while it reports is refused rather than appended to a list it
 * has already read.
 *
 * THE ONE SANCTIONED SECOND NOTICE — a file still uploading when the sweep
 * fired (a single PUT longer than QUIET_MIN on a slow phone): its landed call
 * is refused (closed), then the page's upload-complete finds the row taken and
 * reports only the names the sweep never had (`lateFiles`). Losing that file's
 * report is the bug this slice exists to fix; a second, short notice is the
 * lesser cost.
 *
 * A batch key is NOT a capability: source, case and contact must match the
 * row on every call, else the call is refused (landed) or ignored (close —
 * the page's own list is reported as before batches existed).
 *
 * TIMES are UTC_TIMESTAMP() throughout — the quiet and stale clocks are SQL's,
 * never the instance's (tests age rows in SQL; no fake timers).
 */

'use strict';

const { withTransaction } = require('../lib/withTransaction');

const SOURCES = Object.freeze(['docreq', 'portal']);
const KEY_RE = /^[A-Za-z0-9_-]{16,40}$/;

/** Entries stored per row; file_count keeps counting past it. */
const MAX_FILES = 200;
/** Files handed to the completion phase — the routes' MAX_UPLOAD_FILES (and docsIntakeLog.MAX_FILES). */
const NOTICE_FILES = 50;
const MAX_NAME = 255;
const MAX_COMMENT = 2000;
/** An unclosed row quiet this long after its last file is lost. */
const QUIET_MIN = 10;
/** A claim this old without notified_at died with its instance. Same window as hookDrain / mail_attachment_filings. */
const STALE_CLAIM_MIN = 15;
/** Rows per sweep pass (lost batches are rare; each costs a folder listing + an email). */
const SWEEP_LIMIT = 20;

const T = 'client_upload_batches';

// Lazy (convention: reached from route side-effect phases and the cron).
const completion = () => require('./clientUploadCompletionService');

/** The app pool carries db.withTransaction (startup/db.js); a bare mysql2 pool gets the lib's. Pure-DB spans → retries:1. */
function tx(db, fn) {
  return typeof db.withTransaction === 'function'
    ? db.withTransaction(fn, { retries: 1 })
    : withTransaction(db, fn, { retries: 1 });
}

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
const isBatchKey = (v) => typeof v === 'string' && KEY_RE.test(v);

/** { name, item_id, item_name } from whatever a caller holds; null when it names nothing. */
function normFile(f) {
  if (f == null) return null;
  const o = typeof f === 'object' ? f : { name: f };
  const name = String(o.name ?? '').slice(0, MAX_NAME);
  if (!name.trim()) return null;
  const id = Number(o.item_id);
  const itemId = o.item_id != null && Number.isInteger(id) && id > 0 ? id : null;
  return {
    name,
    item_id: itemId,
    item_name: itemId != null && o.item_name != null ? String(o.item_name).slice(0, MAX_NAME) : null,
  };
}

/** The stored `files` text → entries (tolerates a mangled cell: [] rather than a throw). */
function parseFiles(text) {
  let arr;
  try { arr = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((f) => {
    const n = normFile(f);
    if (n && f && f.landed_at) n.landed_at = String(f.landed_at);
    return n;
  }).filter(Boolean);
}

/**
 * Union by name, LANDED FIRST — a multiset, so two different files that share
 * a name (Dropbox autorenames the second) stay two. A client entry matching a
 * landed one fills a missing item association; one with no landed match is
 * appended (its landed call was lost).
 */
function mergeFiles(landed, client) {
  const out = landed.map((f) => ({ ...f }));
  const unmatched = new Map();
  out.forEach((f, i) => {
    const k = lower(f.name);
    if (!unmatched.has(k)) unmatched.set(k, []);
    unmatched.get(k).push(i);
  });
  for (const c of client) {
    const q = unmatched.get(lower(c.name));
    if (q && q.length) {
      const i = q.shift();
      if (out[i].item_id == null && c.item_id != null) {
        out[i].item_id = c.item_id;
        out[i].item_name = c.item_name;
      }
    } else {
      out.push({ name: c.name, item_id: c.item_id, item_name: c.item_name });
    }
  }
  return out;
}

/** Client entries with no counterpart in `reported` (multiset difference by name). */
function subtractFiles(client, reported) {
  const left = new Map();
  for (const f of reported) left.set(lower(f.name), (left.get(lower(f.name)) || 0) + 1);
  const out = [];
  for (const c of client) {
    const k = lower(c.name);
    const n = left.get(k) || 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(c);
  }
  return out;
}

/**
 * One file landed. ONE statement: an upsert that opens the row or appends to
 * it — only while the row is open AND its source/case/contact match the call.
 * Anything else leaves the row untouched (refused, with a warning).
 *
 * Accepted vs refused rides the insert id: the update branch sets
 * LAST_INSERT_ID(id) only when it accepts, so insertId is the row id when the
 * file was taken and 0 when it was refused (MySQL 8; asserted on the real
 * engine in tests/clientUploadBatchService.mysql.test.js).
 *
 * @param {object} db
 * @param {object} o
 * @param {'docreq'|'portal'} o.source
 * @param {string} o.batchKey
 * @param {string} o.caseId          canonical cases.case_id (the route resolved it)
 * @param {number} [o.contactId]     portal: the authenticated uploader
 * @param {object} o.file            { name, item_id?, item_name? } — item_name from the DB, never the client
 * @param {string} [o.comment]
 * @returns {Promise<{accepted:true, id:number, opened:boolean}|{accepted:false, reason:'invalid'|'closed'|'mismatch'}>}
 *   Throws only on a DB error.
 */
async function landed(db, { source, batchKey, caseId, contactId = null, file, comment } = {}) {
  const f = normFile(file);
  if (!SOURCES.includes(source) || !isBatchKey(batchKey) || !caseId || !f) {
    return { accepted: false, reason: 'invalid' };
  }
  const cid = numOrNull(contactId);
  const note = comment == null ? '' : String(comment).slice(0, MAX_COMMENT);
  const OK = `${T}.closed_at IS NULL AND ${T}.notified_at IS NULL
              AND ${T}.source = new.source AND ${T}.case_id = new.case_id AND ${T}.contact_id <=> new.contact_id`;
  const [r] = await db.query(
    `INSERT INTO ${T} (batch_key, source, case_id, contact_id, comment, files, file_count, opened_at, last_landed_at)
     VALUES (?, ?, ?, ?, NULLIF(?, ''),
             JSON_ARRAY(JSON_OBJECT('name', ?, 'item_id', ?, 'item_name', ?,
                                    'landed_at', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'))),
             1, UTC_TIMESTAMP(), UTC_TIMESTAMP()) AS new
     ON DUPLICATE KEY UPDATE
       id             = IF(${OK}, LAST_INSERT_ID(${T}.id), ${T}.id),
       files          = IF(${OK} AND JSON_LENGTH(${T}.files) < ${MAX_FILES},
                           JSON_ARRAY_APPEND(${T}.files, '$', JSON_EXTRACT(new.files, '$[0]')), ${T}.files),
       file_count     = IF(${OK}, ${T}.file_count + 1, ${T}.file_count),
       comment        = IF(${OK}, COALESCE(new.comment, ${T}.comment), ${T}.comment),
       last_landed_at = IF(${OK}, UTC_TIMESTAMP(), ${T}.last_landed_at)`,
    [batchKey, source, String(caseId), cid, note, f.name, f.item_id, f.item_name]
  );
  if (Number(r.insertId) > 0) {
    // affectedRows: 1 = the row was opened, 2 = appended (mysql2 sets FOUND_ROWS)
    return { accepted: true, id: Number(r.insertId), opened: r.affectedRows === 1 };
  }

  // Refused — say why (the rare path; one read).
  let reason = 'closed';
  try {
    const [[row]] = await db.query(`SELECT source, case_id, contact_id FROM ${T} WHERE batch_key = ?`, [batchKey]);
    if (row && (row.source !== source || lower(row.case_id) !== lower(caseId) || numOrNull(row.contact_id) !== cid)) reason = 'mismatch';
  } catch (_) { /* the warning below still names the batch */ }
  console.warn(`[UPLOAD BATCH] landed refused (${reason}) — ${source} case ${caseId}, batch ${batchKey.slice(0, 8)}…`);
  return { accepted: false, reason };
}

/**
 * The page finished: close the row and claim its completion.
 *
 * A batch whose every landed call was lost — or whose landed calls are still in
 * flight behind this close (fire-and-forget fetches can arrive after the final
 * POST, on another instance) — gets its row HERE, already closed, so a late
 * landed call is refused instead of opening a row the sweep would report a
 * second time. Created only for a case that exists.
 *
 * @returns {Promise<
 *   {status:'owned', id, files, fileCount, comment}   this call claimed it — run the completion, then markNotified
 * | {status:'taken', id, lateFiles}                   the sweep (or an earlier close) holds or finished it; lateFiles = names it never had
 * | {status:'mismatch'}                               the key names another source/case/contact's batch — ignore it
 * | {status:'none'}                                   no row and no such case
 * | null>}                                            bad input
 *   Throws on a DB error.
 */
async function closeByClient(db, { source, batchKey, caseId, contactId = null, files, fileCount, comment } = {}) {
  if (!SOURCES.includes(source) || !isBatchKey(batchKey) || !caseId) return null;
  const client = (Array.isArray(files) ? files : []).map(normFile).filter(Boolean);
  const cid = numOrNull(contactId);
  const note = comment == null ? '' : String(comment).slice(0, MAX_COMMENT);

  return tx(db, async (conn) => {
    const [[kase]] = await conn.query('SELECT case_id FROM cases WHERE case_id = ?', [String(caseId)]);
    if (kase) {
      await conn.query(
        `INSERT IGNORE INTO ${T} (batch_key, source, case_id, contact_id, files, file_count, opened_at, last_landed_at)
         VALUES (?, ?, ?, ?, '[]', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [batchKey, source, kase.case_id, cid]
      );
    }
    const [[row]] = await conn.query(
      `SELECT id, source, case_id, contact_id, comment, files, file_count,
              (notified_at IS NULL AND (claimed_at IS NULL OR claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)) AS claimable
         FROM ${T} WHERE batch_key = ? FOR UPDATE`,
      [STALE_CLAIM_MIN, batchKey]
    );
    if (!row) return { status: 'none' };
    if (row.source !== source || lower(row.case_id) !== lower(caseId) || numOrNull(row.contact_id) !== cid) {
      return { status: 'mismatch' };
    }
    const landedFiles = parseFiles(row.files);
    if (!Number(row.claimable)) {
      return { status: 'taken', id: Number(row.id), lateFiles: subtractFiles(client, landedFiles) };
    }
    // The page's list is authoritative for this path (as before batches); merged
    // with what landed, so a file whose landed call was lost still counts, and
    // one the page dropped from its list (but landed) does too.
    const merged = mergeFiles(landedFiles, client);
    const count = Math.max(
      Number(row.file_count) || 0,
      Number.isInteger(fileCount) && fileCount >= client.length ? fileCount : client.length,
      merged.length
    );
    const finalComment = note || row.comment || null;
    await conn.query(
      `UPDATE ${T}
          SET files = ?, file_count = ?, comment = ?,
              closed_at = COALESCE(closed_at, UTC_TIMESTAMP()), closed_by = 'client',
              claimed_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [JSON.stringify(merged.slice(0, MAX_FILES)), count, finalComment, row.id]
    );
    return { status: 'owned', id: Number(row.id), files: merged, fileCount: count, comment: finalComment };
  });
}

/** The completion ran. Never throws; false = the stamp failed (the sweep's retry branch will re-run it). */
async function markNotified(db, id) {
  try {
    await db.query(
      `UPDATE ${T}
          SET notified_at = UTC_TIMESTAMP(),
              closed_at = COALESCE(closed_at, UTC_TIMESTAMP()),
              closed_by = COALESCE(closed_by, 'sweep')
        WHERE id = ?`,
      [id]
    );
    return true;
  } catch (err) {
    console.error(`[UPLOAD BATCH] notified stamp failed for batch row ${id}: ${err.message}`);
    return false;
  }
}

/**
 * The upload-complete side of both routes, when the page sent its batch key.
 * Runs AFTER the 200. Returns { status, result } (result = the completion's
 * return, or null when there was nothing new to report).
 *
 * @param {object} db
 * @param {object} o  { source, batchKey, caseId, contactId?, clientName?, files, fileCount, comment }
 *                    — files/fileCount/comment already normalised and capped by the route
 */
async function finishByClient(db, o = {}) {
  const { source, batchKey, caseId, contactId = null, clientName = null, files, fileCount, comment } = o;
  const base = { source, caseId };
  if (contactId != null) base.contactId = contactId;
  if (clientName) base.clientName = clientName;

  let closed = null;
  try {
    closed = await closeByClient(db, { source, batchKey, caseId, contactId, files, fileCount, comment });
  } catch (err) {
    console.error(`[UPLOAD BATCH] close failed — ${source} case ${caseId}: ${err.message}`);
  }

  if (!closed || closed.status === 'none' || closed.status === 'mismatch') {
    // No row this call may own (a DB blip, the table missing, a key naming
    // another batch): the page's own list, exactly as before batches existed.
    // The key goes in the log row only when it is not someone else's.
    const res = await completion().completeClientUpload(db, {
      ...base, files, fileCount, comment,
      ...(closed && closed.status === 'mismatch' ? {} : { batchKey }),
    });
    return { status: closed ? closed.status : 'error', result: res };
  }

  if (closed.status === 'owned') {
    const res = await completion().completeClientUpload(db, {
      ...base,
      files: closed.files.slice(0, NOTICE_FILES),
      fileCount: closed.fileCount,
      comment: closed.comment,
      closedBy: 'client',
      batchKey,
    });
    await markNotified(db, closed.id);
    return { status: 'owned', result: res };
  }

  // taken: the other path reports what the row holds; only names it never had are news.
  if (!closed.lateFiles.length) return { status: 'taken', result: null };
  console.warn(`[UPLOAD BATCH] ${closed.lateFiles.length} file(s) reported after the batch was swept — ${source} case ${caseId}; sending them on their own`);
  const res = await completion().completeClientUpload(db, {
    ...base,
    files: closed.lateFiles.slice(0, NOTICE_FILES),
    fileCount: closed.lateFiles.length,
    comment,
    closedBy: 'client',
    batchKey,
  });
  return { status: 'taken', result: res };
}

/**
 * The cron's housekeeping (routes/process_jobs.js, BEFORE the job claim).
 * Candidates by a plain read (most ticks: nothing due — one indexed read, no
 * transaction); when there are some, ONE short transaction locks them by
 * primary key with the predicate re-checked (FOR UPDATE SKIP LOCKED; the
 * process_jobs batch-claim pattern: no locking range scan) and claims them —
 * then the completion runs per row OUTSIDE it (Dropbox + email must not hold a
 * transaction).
 *
 * Due: not notified, not freshly claimed, and either
 *   · open and quiet QUIET_MIN since its last file (the page died), or
 *   · closed QUIET_MIN ago and never notified (the completion died after the
 *     200 — or an earlier sweep died mid-report).
 *
 * Never throws. Returns { claimed, notified, failed }.
 */
async function sweepLostBatches(db, { quietMin = QUIET_MIN, staleClaimMin = STALE_CLAIM_MIN, limit = SWEEP_LIMIT } = {}) {
  const out = { claimed: 0, notified: 0, failed: 0 };
  const DUE = `notified_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)
          AND ((closed_at IS NULL AND last_landed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)
            OR (closed_at IS NOT NULL AND closed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE))`;
  const dueParams = [staleClaimMin, quietMin, quietMin];

  let rows;
  try {
    const [cands] = await db.query(
      `SELECT id FROM ${T} WHERE ${DUE} ORDER BY last_landed_at, id LIMIT ?`,
      [...dueParams, limit]
    );
    if (!Array.isArray(cands) || !cands.length) return out;
    rows = await tx(db, async (conn) => {
      const [locked] = await conn.query(
        `SELECT id, batch_key, source, case_id, contact_id, comment, files, file_count, closed_by
           FROM ${T} WHERE id IN (?) AND ${DUE} FOR UPDATE SKIP LOCKED`,
        [cands.map((r) => r.id), ...dueParams]
      );
      if (!Array.isArray(locked) || !locked.length) return [];
      // closed_at AT CLAIM: from here a landed call is refused, so the list read above is the list reported.
      await conn.query(
        `UPDATE ${T}
            SET claimed_at = UTC_TIMESTAMP(),
                closed_at = COALESCE(closed_at, UTC_TIMESTAMP()),
                closed_by = COALESCE(closed_by, 'sweep')
          WHERE id IN (?)`,
        [locked.map((r) => r.id)]
      );
      return locked;
    });
  } catch (err) {
    console.warn(`[UPLOAD BATCH] sweep claim failed (non-fatal): ${err.code || ''} ${err.message}`);
    return out;
  }

  out.claimed = rows.length;
  for (const row of rows) {
    try {
      const files = parseFiles(row.files);
      const fileCount = Math.max(Number(row.file_count) || 0, files.length);
      if (!fileCount) {   // nothing ever landed (cannot normally exist) — nothing to say
        if (await markNotified(db, row.id)) out.notified++; else out.failed++;
        continue;
      }
      const contactId = numOrNull(row.contact_id);
      let clientName = null;
      if (contactId != null) {
        try {
          const [[c]] = await db.query('SELECT contact_name FROM contacts WHERE contact_id = ?', [contactId]);
          clientName = (c && c.contact_name) || null;
        } catch (_) { /* the completion falls back to the case's Primary contact */ }
      }
      const o = {
        source: row.source,
        caseId: row.case_id,
        files: files.slice(0, NOTICE_FILES),
        fileCount,
        comment: row.comment || null,
        // closed_by as it stood BEFORE this claim: 'client' = the page finished and
        // only its aftermath died — the notice must not say the page closed early.
        closedBy: row.closed_by === 'client' ? 'client' : 'sweep',
        batchKey: row.batch_key,
      };
      if (contactId != null) o.contactId = contactId;
      if (clientName) o.clientName = clientName;
      await completion().completeClientUpload(db, o);
      if (await markNotified(db, row.id)) out.notified++; else out.failed++;
    } catch (err) {
      out.failed++;   // the claim stays; the row is retried once it is stale
      console.error(`[UPLOAD BATCH] sweep completion failed for batch row ${row.id} (case ${row.case_id}): ${err.message}`);
    }
  }
  if (out.claimed) console.log(`[UPLOAD BATCH] swept ${out.claimed} lost batch(es): ${out.notified} notified, ${out.failed} failed`);
  return out;
}

module.exports = {
  landed,
  closeByClient,
  finishByClient,
  markNotified,
  sweepLostBatches,
  isBatchKey,
  SOURCES,
  KEY_RE,
  MAX_FILES,
  NOTICE_FILES,
  QUIET_MIN,
  STALE_CLAIM_MIN,
  // exported for tests
  _mergeFiles: mergeFiles,
  _subtractFiles: subtractFiles,
  _parseFiles: parseFiles,
  _normFile: normFile,
};
