// lib/hookSpool.js
//
/**
 * Hook spool — durable capture of inbound webhooks during a write freeze.
 *
 * While MAINTENANCE_MODE=1 (lib/maintenance.js) the hook receiver cannot run
 * its pipeline: the database must not be written. Instead it hands the
 * already-authenticated, already-built `input` to put(), which stores it as a
 * Cloud Task on a PAUSED queue and returns. After the freeze the operator
 * resumes the queue and Cloud Tasks POSTs each captured event to
 * /internal/hook-replay (routes/internal/hookReplay.js), which runs the normal
 * pipeline.
 *
 * WHY CLOUD TASKS, AND WHY A PAUSED QUEUE
 *   - It is storage that is NOT the database being frozen, and the app already
 *     talks to it (lib/taskQueue.js).
 *   - "A paused queue still accepts tasks; it only stops dispatching" (Cloud
 *     Tasks queues.pause reference, checked 2026-10-12). So pause = capture,
 *     resume = replay, with Cloud Tasks' own retry and rate limiting — there
 *     is no replay tool to write or to get wrong at 3 AM.
 *   - Tasks are kept up to 31 days; a task may be up to 1 MiB.
 *
 * WHY THE BUILT `input`, NOT THE RAW HTTP REQUEST
 *   - Authentication has already run, against the real hook config, at the
 *     moment of receipt. A timestamped-HMAC sender (Calendly) is rejected
 *     outside its tolerance window, so a raw request replayed an hour later
 *     would fail auth.
 *   - `input.headers` has already been through stripSensitiveHeaders, so no
 *     x-api-key / authorization / cookie value is parked in the queue.
 *
 * THIS IS NOT lib/taskQueue.js WITH A BODY — the contracts are opposite:
 *   taskQueue  never rejects; a failed enqueue only costs latency (the cron is
 *              the authority), so it swallows everything.
 *   hookSpool  put() REJECTS on any failure. During a freeze the task IS the
 *              only copy of the event; the caller must learn it was not stored
 *              so it can answer 503 and let the sender retry. A swallowed
 *              error here is exactly the silent loss this module exists to
 *              prevent.
 *   It also ignores the cloud_tasks_enabled kill switch: that flag governs an
 *   optional accelerator; this is a correctness path.
 *
 * CONFIG
 *   CLOUD_TASKS_LOCATION      queue region (env; shared with lib/taskQueue.js)
 *   CLOUD_TASKS_SPOOL_QUEUE   queue name (env; default 'yc-hook-spool')
 *   CLOUD_TASKS_TARGET_URL    optional base URL override; default cfg('app_url')
 *   internal_api_key          firmConfig — rides on the task as x-api-key
 *
 * QUEUE SETUP (once; see ref/INFRA_GCP.md §6 step 9 and §9):
 *   paused right after creation; max-concurrent-dispatches 1 (keeps replay
 *   close to arrival order — Cloud Tasks does not guarantee order); and
 *   UNLIMITED attempts (max-attempts -1). Cloud Tasks deletes a task once its
 *   attempts run out, whatever the status code — so with a finite budget any
 *   systematic replay failure (a queue resumed during the freeze, a rotated
 *   key, a bug) would silently empty the spool. With unlimited attempts a task
 *   leaves the queue only when the replay route answers 2xx; a stuck task
 *   stays visible (`gcloud tasks list`) until someone deals with it, bounded
 *   by the 31-day task lifetime.
 */

'use strict';

const crypto = require('crypto');

const REPLAY_PATH = '/internal/hook-replay';
const DEFAULT_QUEUE = 'yc-hook-spool';

// Cloud Tasks caps a task at 1 MiB. 900 KiB of body leaves ~120 KiB for the
// URL, headers and message envelope. (The Node client speaks gRPC, so the body
// travels as bytes — there is no base64 expansion to budget for.)
const MAX_BODY_BYTES = 900 * 1024;

const SPOOL_ID_RE = /^[a-f0-9]{32}$/;

let client = null;            // lazy CloudTasksClient (ADC)
let projectIdPromise = null;  // cached client.getProjectId()

function resolveConfig() {
  // Deferred require — same load-order reason as lib/taskQueue.js.
  const { cfg } = require('./firmConfig');
  return {
    location: process.env.CLOUD_TASKS_LOCATION || null,
    queue: process.env.CLOUD_TASKS_SPOOL_QUEUE || DEFAULT_QUEUE,
    targetBase: process.env.CLOUD_TASKS_TARGET_URL || cfg('app_url'),
    apiKey: cfg('internal_api_key'),
  };
}

/** 32 lowercase hex chars — valid inside a Cloud Tasks task name as-is. */
function newSpoolId() {
  return crypto.randomBytes(16).toString('hex');
}

function isSpoolId(v) {
  return typeof v === 'string' && SPOOL_ID_RE.test(v);
}

async function getClient() {
  if (!client) {
    const { CloudTasksClient } = require('@google-cloud/tasks');
    client = new CloudTasksClient();
  }
  if (!projectIdPromise) {
    // Never cache a rejection (one metadata-server blip must not disable the
    // spool for the life of the instance).
    projectIdPromise = client.getProjectId().catch((err) => {
      projectIdPromise = null;
      throw err;
    });
  }
  return { client, projectId: await projectIdPromise };
}

/**
 * Store one captured hook event. REJECTS if it could not be stored.
 *
 * @param {object} args
 * @param {string} args.slug     the slug the sender POSTed to (may be unmatched —
 *                               the replay re-resolves, catch-all included)
 * @param {object} args.input    the receiver's unified event object; its
 *                               meta.spool_id must equal `spoolId`
 * @param {string} args.spoolId  from newSpoolId()
 * @returns {Promise<{spoolId: string, bytes: number, queue: string, duplicate: boolean}>}
 */
async function put({ slug, input, spoolId }) {
  if (typeof slug !== 'string' || !slug) throw new Error('hookSpool.put: slug required');
  if (!input || typeof input !== 'object') throw new Error('hookSpool.put: input required');
  if (!isSpoolId(spoolId)) throw new Error('hookSpool.put: spoolId must come from newSpoolId()');
  if (!input.meta || input.meta.spool_id !== spoolId) {
    // The replay's idempotency check reads meta.spool_id out of the stored
    // execution row; an event spooled without it could run twice.
    throw new Error('hookSpool.put: input.meta.spool_id must equal spoolId');
  }

  const conf = resolveConfig();
  if (!conf.location || !conf.targetBase || !conf.apiKey) {
    throw new Error('hookSpool misconfigured (need CLOUD_TASKS_LOCATION + app_url/CLOUD_TASKS_TARGET_URL + internal_api_key)');
  }

  const body = Buffer.from(JSON.stringify({ spool_id: spoolId, slug, input }), 'utf8');
  if (body.length > MAX_BODY_BYTES) {
    throw new Error(`hookSpool: event too large to spool (${body.length} bytes > ${MAX_BODY_BYTES})`);
  }

  const { client: c, projectId } = await getClient();
  const parent = c.queuePath(projectId, conf.location, conf.queue);
  const task = {
    // Named by spool id: a retried put() for the same event cannot enqueue it
    // twice (ALREADY_EXISTS below).
    name: c.taskPath(projectId, conf.location, conf.queue, `hs-${spoolId}`),
    httpRequest: {
      httpMethod: 'POST',
      url: String(conf.targetBase).replace(/\/+$/, '') + REPLAY_PATH,
      headers: { 'x-api-key': conf.apiKey, 'content-type': 'application/json' },
      body,
    },
  };

  try {
    // 8s: this call is awaited on the request path (full CPU), and the sender
    // is holding its connection open for our answer.
    await c.createTask({ parent, task }, { timeout: 8000 });
  } catch (err) {
    // gRPC 6 = ALREADY_EXISTS — this exact event is already stored.
    if (err && err.code === 6) {
      return { spoolId, bytes: body.length, queue: conf.queue, duplicate: true };
    }
    throw err;
  }
  return { spoolId, bytes: body.length, queue: conf.queue, duplicate: false };
}

/**
 * Boot-time warmup for a maintenance revision — call from startup/init.js.
 * NEVER throws. Establishes the channel at full CPU and says, in one log line,
 * whether the spool queue exists and whether it is paused: a RUNNING spool
 * queue during a freeze dispatches straight into the maintenance gate's 503
 * and spends its retry budget.
 *
 * @returns {Promise<'paused'|'running'|'unknown'|'missing'|'unconfigured'|'error'>}
 */
async function warmup() {
  try {
    const conf = resolveConfig();
    // The same three things put() refuses to work without — say so at boot
    // rather than on the first webhook.
    const missing = [
      !conf.location && 'CLOUD_TASKS_LOCATION',
      !conf.targetBase && 'app_url',
      !conf.apiKey && 'internal_api_key',
    ].filter(Boolean);
    if (missing.length) {
      console.error(`[hookSpool] NOT CONFIGURED (missing ${missing.join(', ')}) — captured hooks CANNOT be stored; the receiver will answer 503`);
      return 'unconfigured';
    }
    const { client: c, projectId } = await getClient();
    const [q] = await c.getQueue(
      { name: c.queuePath(projectId, conf.location, conf.queue) },
      { timeout: 15000 }
    );
    const state = String((q && q.state) || '').toUpperCase();
    if (state === 'PAUSED' || state === '2') {
      console.log(`[hookSpool] ready — queue ${conf.queue} (${conf.location}) exists and is PAUSED`);
      return 'paused';
    }
    console.warn(`[hookSpool] queue ${conf.queue} is ${state || 'in an unknown state'}, not PAUSED — captured hooks will be dispatched into the maintenance 503 and retried; pause it`);
    return 'running';
  } catch (err) {
    if (err && err.code === 7) {
      console.log('[hookSpool] channel established (grant roles/cloudtasks.viewer to verify the queue state at boot)');
      return 'unknown';
    }
    if (err && err.code === 5) {
      console.error(`[hookSpool] spool queue NOT FOUND — captured hooks cannot be stored; create it (${err.message})`);
      return 'missing';
    }
    console.warn(`[hookSpool] warmup failed: ${err.message}`);
    return 'error';
  }
}

/** Test hook — inject a fake client / reset module state between tests. */
function _test({ client: c } = {}) {
  if (c !== undefined) { client = c; projectIdPromise = null; }
}

module.exports = {
  put, warmup, newSpoolId, isSpoolId,
  REPLAY_PATH, DEFAULT_QUEUE, MAX_BODY_BYTES, _test,
};
