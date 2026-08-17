// routes/api.checklists.js
//
/**
 * Checklist Routes
 * 
 * GET    /checklists                          list + filters + item counts (see route)
 * GET    /checklists/:id                      single checklist + items
 * POST   /checklists                          create
 * PATCH  /checklists/:id                      update title/tag/link/link_type
 * DELETE /checklists/:id                      delete (cascades items)
 * POST   /checklists/:id/items                add item
 * PATCH  /checkitems/:id                      update item (name, status)
 * DELETE /checkitems/:id                      delete item
 * POST   /checklists/upsert-items             find-or-create docs checklist (tag='docs_needed') + upsert items
 *
 * Public (no auth):
 * GET    /api/public/docs/:caseId             rate-limited, returns name + incomplete docs items
 * POST   /api/public/get-upload-link          rate-limited, Dropbox temp upload link
 * POST   /api/public/upload-complete          rate-limited, notifies staff + logs
 *
 * The three public routes above are UNAUTHENTICATED (case_id is the only
 * capability). Treat every value off req.body/req.params as hostile: bind it
 * into SQL, and escapeHtml() it before it reaches an email body.
 *
 * IDENTITY: the case docs checklist is identified by tag='docs_needed', NOT by
 * title — titles are staff-editable from checklistView.html. The same predicate
 * lives in services/portalDocsService.js (listDocs, _caseItemMap); change one
 * without the other and the client portal / docReq silently go blank.
 *
 * OWNERSHIP: link_type='user' rows are gated against DETACHMENT only —
 * deleting one, or re-homing it away from its owner — via mayDetachPersonal().
 * Creating a list FOR another user, and adding/checking/renaming/removing its
 * items, are all open: delegation is the point. Reads are never gated.
 *
 * TAGS: `tag` is a system field on both tables — writes are api_key/SU only,
 * via mayWriteTag(). Staff edit titles; tags are set by machines. Surfaces
 * should render the tag as an immutable badge, never an input.
 *
 * UNIQUENESS: UNIQUE KEY uq_link_tag (link_type, link, tag) allows at most one
 * TAGGED checklist per entity per tag, while leaving untagged lists unlimited
 * (MySQL exempts rows with a NULL in the key). POST and PATCH surface a
 * violation as 409, not 500. upsert-items instead RECOVERS from it — a
 * concurrent caller winning the insert race is not an error there.
 *
 * mayDetachPersonal() is deliberately NOT exported. Test it the way
 * tests/portalDocsRoutes.js tests its route: mount this router in a real
 * express app on an ephemeral port with jwtOrApiKey mocked to inject req.auth,
 * and drive owner / non-owner / SU / api_key across PATCH + DELETE over HTTP.
 * That exercises the gate where it actually runs.
 */

const express      = require('express');
const router       = express.Router();
const rateLimit    = require('express-rate-limit');
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const { isSuperuser } = require('../lib/auth.superuser');
// Shared with services/caseService.js (merge consolidation) — see the lib for
// the rule. Do not re-implement it here.
const { computeAndSaveStatus } = require('../lib/checklistStatus');
const domainEvents = require('../lib/domainEvents'); // Trigger T4
const emailService = require('../services/emailService');
const logService   = require('../services/logService');
const uploadTarget = require('../services/uploadTargetService');
const { getSetting } = require('../services/settingsService');
const { cfg } = require('../lib/firmConfig');
// Pipeline Slice E1 (Task 2): retained→docs hook below. pipelineService pulls
// only lib/withTransaction (no cycle); alerting's heavier deps (phoneService)
// are lazy-required inside it.
const pipelineService = require('../services/pipelineService');
const { alert } = require('../lib/alerting');
const {
  NOTIFY_TO_KEY,
  // ONE rule set, shared with the authenticated portal upload path
  // (services/portalDocsService.createUploadLink). Do not fork these.
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  _extOf: extOf,
} = require('../services/portalDocsService');

// ─── Helpers ────────────────────────────────────────────────────

/**
 * HTML-escape a value for interpolation into notification email bodies.
 *
 * Deliberately file-local rather than imported — matches the existing repo
 * convention (services/taskService.js, services/eventService.js and
 * services/esignSendService.js each carry their own copy). Keep in sync.
 *
 * Covers text nodes AND double-quoted attribute values (both quote forms are
 * escaped), which is what the upload notification needs: case_dropbox lands
 * inside an href.
 *
 * MIME subject headers must NOT be escaped — escaping a mail header puts a
 * literal &amp; in the recipient's inbox. Only HTML bodies go through this.
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Caps on client-supplied input reaching the public upload-complete route.
// This route is UNAUTHENTICATED — everything in req.body is hostile until
// proven otherwise, and unbounded strings would land in a staff inbox and
// the log table verbatim.
const MAX_UPLOAD_FILES    = 50;
const MAX_UPLOAD_FILENAME = 255;
const MAX_UPLOAD_COMMENT  = 2000;

async function getChecklistWithItems(db, checklistId) {
  const [[checklist]] = await db.query(
    'SELECT * FROM checklists WHERE id = ?', [checklistId]
  );
  if (!checklist) return null;
  const [items] = await db.query(
    'SELECT * FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC',
    [checklistId]
  );
  return { ...checklist, items };
}

// ─── Validation vocab ────────────────────────────────────────────
// Mirrors the live enums. Validating instead of silently passing a bad value
// into the WHERE matters: an unrecognised link_type would otherwise return an
// empty list, which reads as "you have no checklists" rather than "typo".
const LINK_TYPES = ['contact', 'case', 'bill', 'appt', 'task', 'user'];
const STATUSES   = ['incomplete', 'complete'];

// Whitelisted ORDER BY — never interpolate client text into the clause.
// Default is created_asc: case.html renders checklists in creation order and
// the old route hardcoded `ORDER BY created_date ASC`. Do not change the
// default without checking that page.
const ORDERS = {
  created_asc:  'cl.created_date ASC, cl.id ASC',
  created_desc: 'cl.created_date DESC, cl.id DESC',
  updated_desc: 'cl.updated_date DESC, cl.id DESC',
  updated_asc:  'cl.updated_date ASC, cl.id ASC',
  title_asc:    'cl.title ASC, cl.id ASC',
};
const DEFAULT_ORDER = 'created_asc';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 1000;

// ─── Personal-list detach gate ───────────────────────────────────
/**
 * Only link_type='user' rows are gated, and only against being DETACHED from
 * their owner — deleted, or re-homed to a different link. Everything else
 * (case/contact/bill/appt/task lists, and unlinked lists) is open to any
 * authenticated staff user, same posture as every other entity surface here.
 *
 * WHY THIS IS NARROW. An earlier revision gated every write on a user list.
 * That broke the actual use case: user A making a list FOR user B, then adding
 * items to it. Delegation is the point of a personal list you didn't create.
 * So creating a list for someone, adding/checking/renaming/removing its items,
 * and renaming the list are all open. What stays closed is the pair of actions
 * that take the list AWAY from its owner in one click and can't be undone.
 *
 * Emptying someone's list item by item is still possible. That is deliberate:
 * it costs N deliberate clicks with a confirm each, where DELETE costs one, and
 * pretending otherwise would mean blocking the collaboration this exists for.
 *
 * Passes:
 *   - api_key callers. YisraFlow steps, hooks and the internal self-credential
 *     have no userId (lib/auth.jwtOrApiKey sets req.auth = {type:'api_key'}),
 *     so gating them would break automation for zero security gain — anyone
 *     holding the internal key already owns the box.
 *   - superusers, per lib/auth.superuser.isSuperuser (JWT + user_auth === SU).
 *   - the owner: req.auth.userId === checklists.link.
 *
 * READS are never gated — a personal to-do list is not a secret in a
 * five-person firm, and the index page lists across owners.
 */
function mayDetachPersonal(auth, linkType, link) {
  if (linkType !== 'user') return true;
  if (auth?.type === 'api_key') return true;
  if (isSuperuser(auth)) return true;
  return auth?.userId != null && String(auth.userId) === String(link);
}

function denyPersonal(res) {
  return res.status(403).json({
    status: 'error',
    message: "That personal checklist belongs to another user — you can add to it, "
           + 'but only its owner can delete or move it.',
  });
}

/**
 * `tag` is the MACHINE key, not a label — invariants hang off it. Today
 * tag='docs_needed' drives portalDocsService and docReq; more tagged list
 * types are planned, so the field gets more load-bearing, not less.
 *
 * A staff user must not be able to PATCH tag='docs_needed' onto an arbitrary
 * list (two docs lists on one case) or clear it off the real one (portal card
 * silently goes blank). So writes are machine/SU only:
 *   - api_key callers set tags at creation (upsert-items, workflows, hooks)
 *   - superusers need it to repair data
 *   - everyone else: title is theirs to edit, tag is not
 *
 * checklists.tag AND checkitems.tag are both covered. checkitems.tag is 100%
 * NULL today and nothing reads it, but it is the same kind of field and
 * carving out an exception now just means someone has to notice later.
 */
function mayWriteTag(auth) {
  return auth?.type === 'api_key' || isSuperuser(auth);
}

function denyTag(res) {
  return res.status(403).json({
    status: 'error',
    message: 'tag is a system field and cannot be set here. Edit the title instead.',
  });
}

/**
 * UNIQUE KEY uq_link_tag (link_type, link, tag) enforces "at most one tagged
 * checklist per entity per tag". MySQL treats a row as non-duplicate when ANY
 * column of a unique key is NULL, so untagged lists stay unlimited per entity
 * — which is exactly the invariant we want and is why the constraint is on the
 * three columns rather than on `link` alone (the old, since-dropped index).
 *
 * PRIMARY is auto-increment, so any ER_DUP_ENTRY on a checklists write is this
 * key. The sqlMessage check is belt-and-braces: MySQL 8 renders the key as
 * 'checklists.uq_link_tag' and 5.7 as 'uq_link_tag', so match on the substring.
 */
function isDupTag(err) {
  return !!err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);
}

/** Minimal parent row for a checkitem — id + the two gate columns. */
async function getItemParent(db, itemId) {
  const [[row]] = await db.query(
    `SELECT ci.id AS item_id, ci.status AS item_status,
            cl.id AS checklist_id, cl.status AS checklist_status,
            cl.link_type, cl.link, cl.tag, cl.title
       FROM checkitems ci
       JOIN checklists cl ON cl.id = ci.checklist_id
      WHERE ci.id = ?`,
    [itemId]
  );
  return row || null;
}

// ─── Authenticated routes ────────────────────────────────────────

/**
 * GET /checklists
 *
 * Filters (all optional, AND-combined):
 *   link_type   one of LINK_TYPES                 400 on anything else
 *   link        entity id. The literal `me` resolves to the caller's userId
 *               (GET only — never stored; writes must send a real id).
 *   unlinked=1  link IS NULL. Overrides link/link_type — the "loose lists"
 *               bucket on the index page.
 *   tag         machine key. `tag=none` matches tag IS NULL.
 *   status      incomplete | complete (the auto-computed parent status)
 *   created_by  user id
 *   q           substring match on title
 *   order       one of ORDERS (default created_asc — case.html depends on it)
 *   limit       default 200, max 1000
 *   offset      default 0
 *   include     `items` bulk-loads every item (single IN query, no N+1)
 *
 * Every row carries items_total / items_done so an index page can draw
 * progress without pulling ~1.9k item rows it will never render.
 *
 * Counts are correlated subqueries, NOT a LEFT JOIN + GROUP BY. The session
 * sql_mode here lacks ONLY_FULL_GROUP_BY, so `SELECT cl.* ... GROUP BY cl.id`
 * would work today and break the day strict mode gets enabled. Subqueries are
 * mode-independent, and at a few hundred rows against KEY checklist_id the
 * cost is noise.
 *
 * Response: { checklists, total, limit, offset }. `checklists` is unchanged
 * from the previous shape, so existing callers keep working.
 */
router.get('/checklists', jwtOrApiKey, async (req, res) => {
  try {
    const {
      link_type, link, unlinked, tag, status, created_by, q,
      order, limit, offset, include,
    } = req.query;

    const where  = [];
    const params = [];

    if (link_type !== undefined && link_type !== '') {
      if (!LINK_TYPES.includes(link_type)) {
        return res.status(400).json({
          status: 'error',
          message: `link_type must be one of: ${LINK_TYPES.join(', ')}`,
        });
      }
      where.push('cl.link_type = ?'); params.push(link_type);
    }

    if (unlinked === '1' || unlinked === 'true') {
      where.push('cl.link IS NULL');
    } else if (link !== undefined && link !== '') {
      // `me` sugar so a URL like ?link_type=user&link=me is shareable and the
      // client needn't know its own id. Resolution is read-side only.
      let linkVal = link;
      if (link === 'me') {
        if (req.auth?.userId == null) {
          return res.status(400).json({
            status: 'error',
            message: 'link=me requires a user token (API keys have no user).',
          });
        }
        linkVal = String(req.auth.userId);
      }
      where.push('cl.link = ?'); params.push(linkVal);
    }

    if (tag !== undefined && tag !== '') {
      if (tag === 'none') where.push('cl.tag IS NULL');
      else { where.push('cl.tag = ?'); params.push(tag); }
    }

    if (status !== undefined && status !== '') {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({
          status: 'error',
          message: `status must be one of: ${STATUSES.join(', ')}`,
        });
      }
      where.push('cl.status = ?'); params.push(status);
    }

    if (created_by !== undefined && created_by !== '') {
      where.push('cl.created_by = ?'); params.push(created_by);
    }

    if (q !== undefined && q !== '') {
      where.push('cl.title LIKE CONCAT(\'%\', ?, \'%\')'); params.push(q);
    }

    const orderKey = order || DEFAULT_ORDER;
    if (!Object.prototype.hasOwnProperty.call(ORDERS, orderKey)) {
      return res.status(400).json({
        status: 'error',
        message: `order must be one of: ${Object.keys(ORDERS).join(', ')}`,
      });
    }

    const lim = Math.min(
      Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await req.db.query(
      `SELECT COUNT(*) AS total FROM checklists cl${whereSql}`,
      params
    );

    const [rows] = await req.db.query(
      `SELECT cl.*,
              (SELECT COUNT(*) FROM checkitems ci
                WHERE ci.checklist_id = cl.id) AS items_total,
              (SELECT COUNT(*) FROM checkitems ci
                WHERE ci.checklist_id = cl.id AND ci.status = 'complete') AS items_done
         FROM checklists cl${whereSql}
        ORDER BY ${ORDERS[orderKey]}
        LIMIT ? OFFSET ?`,
      [...params, lim, off]
    );

    // mysql2 returns COUNT(*) (BIGINT) as a STRING. Left raw, the client gets
    // "0"/"10" and any `>` comparison becomes a lexicographic one ("5" > "10"
    // is true). Coerce once, here.
    for (const cl of rows) {
      cl.items_total = Number(cl.items_total);
      cl.items_done  = Number(cl.items_done);
    }

    // Optionally bulk-load items (single query, no N+1)
    if (include === 'items' && rows.length) {
      const ids = rows.map(r => r.id);
      const [allItems] = await req.db.query(
        `SELECT * FROM checkitems WHERE checklist_id IN (?) ORDER BY position ASC, id ASC`,
        [ids]
      );
      const grouped = {};
      for (const item of allItems) {
        (grouped[item.checklist_id] ||= []).push(item);
      }
      for (const cl of rows) {
        cl.items = grouped[cl.id] || [];
      }
    }

    // Opt-in facet: the distinct tag vocabulary, so an index page can build a
    // tag filter that maintains itself instead of hardcoding 'docs_needed'.
    // Behind ?facets=1 on purpose — the case tab hits this route on every tab
    // open and has no filter UI, so it shouldn't pay for a second query.
    const facets = {};
    if (req.query.facets === '1') {
      const [tagRows] = await req.db.query(
        `SELECT DISTINCT tag FROM checklists WHERE tag IS NOT NULL AND tag <> '' ORDER BY tag ASC`
      );
      facets.tags = tagRows.map(r => r.tag);
    }

    res.json({ checklists: rows, total: Number(total), limit: lim, offset: off, ...facets });
  } catch (err) {
    console.error('GET /checklists error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch checklists' });
  }
});

// GET /checklists/:id  — single checklist + items
router.get('/checklists/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await getChecklistWithItems(req.db, req.params.id);
    if (!result) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json(result);
  } catch (err) {
    console.error('GET /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch checklist' });
  }
});

// POST /checklists
router.post('/checklists', jwtOrApiKey, async (req, res) => {
  const { title, link, link_type, tag, items } = req.body;
  if (!title?.trim()) return res.status(400).json({ status: 'error', message: 'title is required' });

  if (link_type != null && link_type !== '' && !LINK_TYPES.includes(link_type)) {
    return res.status(400).json({
      status: 'error',
      message: `link_type must be one of: ${LINK_TYPES.join(', ')}`,
    });
  }
  // Creating a list FOR another user is allowed — that is delegation, and the
  // whole reason a personal list you didn't create is useful. Only detaching
  // one from its owner is gated (see mayDetachPersonal).
  if (link_type === 'user' && (link == null || link === '')) {
    return res.status(400).json({
      status: 'error',
      message: 'link (the user id) is required when link_type is "user".',
    });
  }
  // Tag is machine/SU only — on the list and on any items created with it.
  if (tag != null && tag !== '' && !mayWriteTag(req.auth)) return denyTag(res);
  if (Array.isArray(items) && items.some(i => i?.tag != null && i.tag !== '')
      && !mayWriteTag(req.auth)) return denyTag(res);

  try {
    const [result] = await req.db.query(
      'INSERT INTO checklists (title, created_by, link, link_type, tag) VALUES (?, ?, ?, ?, ?)',
      // `|| 0` matches upsert-items. created_by is tinyint NOT NULL and
      // api_key callers carry no userId — mysql2 throws on an undefined bind
      // param, so without this every workflow-created checklist 500s.
      [title.trim(), req.auth.userId || 0, link || null, link_type || null, tag || null]
    );
    const checklistId = result.insertId;

    if (Array.isArray(items) && items.length) {
      const values = items.map((item, i) => [
        checklistId, item.name, item.status || 'incomplete', item.position ?? i + 1, item.tag || null
      ]);
      await req.db.query(
        'INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES ?',
        [values]
      );
    }

    const checklist = await getChecklistWithItems(req.db, checklistId);
    res.status(201).json(checklist);
  } catch (err) {
    if (isDupTag(err)) {
      // An untagged POST cannot actually collide (NULL exempts the row from
      // uq_link_tag), but don't interpolate `undefined` into a user-facing
      // string on the strength of that reasoning.
      const which = tag ? `tagged "${tag}"` : 'with that tag';
      return res.status(409).json({
        status: 'error',
        message: `A checklist ${which} already exists on that ${link_type || 'entity'}. `
               + 'Only one tagged checklist is allowed per entity per tag.',
      });
    }
    console.error('POST /checklists error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create checklist' });
  }
});

// PATCH /checklists/:id
router.patch('/checklists/:id', jwtOrApiKey, async (req, res) => {
  const { title, tag, link, link_type } = req.body;
  const fields = [], params = [];
  if (title     !== undefined) { fields.push('title = ?');     params.push(title); }
  if (tag       !== undefined) { fields.push('tag = ?');       params.push(tag); }
  if (link      !== undefined) { fields.push('link = ?');      params.push(link); }
  if (link_type !== undefined) { fields.push('link_type = ?'); params.push(link_type); }
  if (!fields.length) return res.status(400).json({ status: 'error', message: 'Nothing to update' });

  if (tag !== undefined && !mayWriteTag(req.auth)) return denyTag(res);

  if (link_type !== undefined && link_type !== null && link_type !== ''
      && !LINK_TYPES.includes(link_type)) {
    return res.status(400).json({
      status: 'error',
      message: `link_type must be one of: ${LINK_TYPES.join(', ')}`,
    });
  }

  try {
    // Load first: the gate needs the CURRENT owner, and re-homing needs the
    // TARGET checked too — otherwise anyone could PATCH their own list onto
    // another user, or PATCH someone else's away from them.
    const [[current]] = await req.db.query(
      'SELECT id, link_type, link FROM checklists WHERE id = ?', [req.params.id]
    );
    if (!current) return res.status(404).json({ status: 'error', message: 'Checklist not found' });

    const nextType = link_type !== undefined ? link_type : current.link_type;
    const nextLink = link      !== undefined ? link      : current.link;
    if (nextType === 'user' && (nextLink == null || nextLink === '')) {
      return res.status(400).json({
        status: 'error',
        message: 'link (the user id) is required when link_type is "user".',
      });
    }
    // Renaming someone else's list is fine. MOVING it away from them is not:
    // that is a detach, same as a delete. Gate on the CURRENT owner, and only
    // when link/link_type is actually changing.
    const detaching = (link_type !== undefined && link_type !== current.link_type)
                   || (link      !== undefined && String(link) !== String(current.link));
    if (detaching && !mayDetachPersonal(req.auth, current.link_type, current.link)) {
      return denyPersonal(res);
    }

    params.push(req.params.id);
    await req.db.query(`UPDATE checklists SET ${fields.join(', ')} WHERE id = ?`, params);
    const checklist = await getChecklistWithItems(req.db, req.params.id);
    if (!checklist) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json(checklist);
  } catch (err) {
    if (isDupTag(err)) {
      // Re-homing a tagged list onto an entity that already has that tag, or
      // setting a tag that collides where the list already sits.
      return res.status(409).json({
        status: 'error',
        message: 'The target already has a checklist with that tag. '
               + 'Only one tagged checklist is allowed per entity per tag.',
      });
    }
    console.error('PATCH /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to update checklist' });
  }
});

// DELETE /checklists/:id
router.delete('/checklists/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [[current]] = await req.db.query(
      'SELECT id, link_type, link FROM checklists WHERE id = ?', [req.params.id]
    );
    if (!current) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    if (!mayDetachPersonal(req.auth, current.link_type, current.link)) return denyPersonal(res);

    const [result] = await req.db.query('DELETE FROM checklists WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ status: 'error', message: 'Checklist not found' });
    res.json({ status: 'success', message: 'Checklist deleted' });
  } catch (err) {
    console.error('DELETE /checklists/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to delete checklist' });
  }
});

// POST /checklists/:id/items
router.post('/checklists/:id/items', jwtOrApiKey, async (req, res) => {
  const { name, status = 'incomplete', position, tag } = req.body;
  if (!name?.trim()) return res.status(400).json({ status: 'error', message: 'name is required' });
  if (tag != null && tag !== '' && !mayWriteTag(req.auth)) return denyTag(res);

  try {
    const [[parent]] = await req.db.query(
      'SELECT id, link_type, link FROM checklists WHERE id = ?', [req.params.id]
    );
    if (!parent) return res.status(404).json({ status: 'error', message: 'Checklist not found' });

    // `position` may legitimately be 0. The old `if (!pos)` treated an
    // explicit 0 as "not supplied" and silently pushed the item to the end.
    let pos = position;
    if (pos === undefined || pos === null || pos === '') {
      const [[{ maxPos }]] = await req.db.query(
        'SELECT COALESCE(MAX(position), 0) AS maxPos FROM checkitems WHERE checklist_id = ?',
        [req.params.id]
      );
      pos = maxPos + 1;
    }
    await req.db.query(
      'INSERT INTO checkitems (checklist_id, name, status, position, tag) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, name.trim(), status, pos, tag || null]
    );
    await computeAndSaveStatus(req.db, req.params.id);
    const checklist = await getChecklistWithItems(req.db, req.params.id);
    res.status(201).json(checklist);
  } catch (err) {
    console.error('POST /checklists/:id/items error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to add item' });
  }
});

// PATCH /checkitems/:id
router.patch('/checkitems/:id', jwtOrApiKey, async (req, res) => {
  const { name, status, position, tag } = req.body;
  const fields = [], params = [];
  if (name     !== undefined) { fields.push('name = ?');     params.push(name); }
  if (status   !== undefined) { fields.push('status = ?');   params.push(status); }
  if (position !== undefined) { fields.push('position = ?'); params.push(position); }
  if (tag      !== undefined) { fields.push('tag = ?');      params.push(tag); }
  if (!fields.length) return res.status(400).json({ status: 'error', message: 'Nothing to update' });

  if (tag !== undefined && !mayWriteTag(req.auth)) return denyTag(res);

  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({
      status: 'error',
      message: `status must be one of: ${STATUSES.join(', ')}`,
    });
  }

  try {
    // Loaded BEFORE the update — the gate needs the parent's owner, and the
    // recompute needs checklist_id anyway (the old code re-read it after).
    const parent = await getItemParent(req.db, req.params.id);
    if (!parent) return res.status(404).json({ status: 'error', message: 'Item not found' });

    params.push(req.params.id);
    await req.db.query(`UPDATE checkitems SET ${fields.join(', ')} WHERE id = ?`, params);

    const newChecklistStatus = await computeAndSaveStatus(req.db, parent.checklist_id);

    const [[updated]] = await req.db.query('SELECT * FROM checkitems WHERE id = ?', [req.params.id]);
    res.json(updated);

    // Triggers (fire-and-forget, post-response). Transition-gated: idempotent
    // re-saves of an already-complete item fire nothing. Own try: the route's
    // catch would double-respond on an already-sent response (R3/S8).
    try {
    const linkContactId = parent.link_type === 'contact' ? (parseInt(parent.link, 10) || null) : null;
    const linkCaseId    = parent.link_type === 'case'    ? String(parent.link) : null;
    if (status === 'complete' && parent.item_status !== 'complete') {
      domainEvents.emit(req.db, 'checkitem.completed', {
        contact_id: linkContactId,
        case_id:    linkCaseId,
        actor: { user_id: (req.auth && req.auth.type === 'jwt' && parseInt(req.auth.userId, 10)) || 0 },
        data: {
          item_id:          updated.id,
          name:             updated.name,
          checklist_id:     parent.checklist_id,
          tag:              parent.tag ?? null,
          title:            parent.title ?? null,
          link_type:        parent.link_type,
          checklist_status: newChecklistStatus,
        },
      });
    }
    if (parent.checklist_status !== 'complete' && newChecklistStatus === 'complete') {
      domainEvents.emit(req.db, 'checklist.completed', {
        contact_id: linkContactId,
        case_id:    linkCaseId,
        actor: { user_id: (req.auth && req.auth.type === 'jwt' && parseInt(req.auth.userId, 10)) || 0 },
        data: {
          checklist_id: parent.checklist_id,
          title:        parent.title ?? null,
          tag:          parent.tag ?? null,
          link_type:    parent.link_type,
        },
      });
    }
    } catch (emitErr) { console.error('PATCH /checkitems/:id trigger emit error:', emitErr.message); }
  } catch (err) {
    console.error('PATCH /checkitems/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to update item' });
  }
});

// DELETE /checkitems/:id
router.delete('/checkitems/:id', jwtOrApiKey, async (req, res) => {
  try {
    const parent = await getItemParent(req.db, req.params.id);
    if (!parent) return res.status(404).json({ status: 'error', message: 'Item not found' });

    await req.db.query('DELETE FROM checkitems WHERE id = ?', [req.params.id]);
    const newChecklistStatus = await computeAndSaveStatus(req.db, parent.checklist_id);
    res.json({ status: 'success', message: 'Item deleted' });

    // Trigger: checklist.completed (fire-and-forget, post-response) — deleting
    // the last incomplete item completes the list. Own try (R3/S8).
    try {
    if (parent.checklist_status !== 'complete' && newChecklistStatus === 'complete') {
      domainEvents.emit(req.db, 'checklist.completed', {
        contact_id: parent.link_type === 'contact' ? (parseInt(parent.link, 10) || null) : null,
        case_id:    parent.link_type === 'case'    ? String(parent.link) : null,
        actor: { user_id: (req.auth && req.auth.type === 'jwt' && parseInt(req.auth.userId, 10)) || 0 },
        data: {
          checklist_id: parent.checklist_id,
          title:        parent.title ?? null,
          tag:          parent.tag ?? null,
          link_type:    parent.link_type,
        },
      });
    }
    } catch (emitErr) { console.error('DELETE /checkitems/:id trigger emit error:', emitErr.message); }
  } catch (err) {
    console.error('DELETE /checkitems/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to delete item' });
  }
});

// POST /checklists/upsert-items
// Replaces the Pabbly/Trello "Docs Needed" upsert logic.
// Finds or creates the case's docs checklist — identified by tag='docs_needed',
// not by title (see below) — then for each item: removes any existing item
// matching the first 22 chars, inserts fresh.
router.post('/checklists/upsert-items', jwtOrApiKey, async (req, res) => {
  const { case_id, items } = req.body;
  if (!case_id) return res.status(400).json({ status: 'error', message: 'case_id is required' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ status: 'error', message: 'items must be a non-empty array' });

  try {
    // Find or create the docs checklist for this case.
    // Identity is tag='docs_needed', NOT the title — the title is staff-editable
    // in checklistView.html. The title clause is a transition fallback for rows
    // created between the backfill and this deploy; drop it once tag coverage
    // is 100% (SELECT COUNT(*) FROM checklists WHERE link_type='case' AND tag IS NULL).
    const FIND_DOCS_SQL =
      `SELECT id, tag FROM checklists
        WHERE link_type = 'case' AND link = ?
          AND (tag = 'docs_needed' OR title = 'Docs Needed')
        ORDER BY (tag = 'docs_needed') DESC, id ASC
        LIMIT 1`;

    let [[checklist]] = await req.db.query(FIND_DOCS_SQL, [case_id]);

    if (!checklist) {
      try {
        const [result] = await req.db.query(
          `INSERT INTO checklists (title, created_by, link, link_type, tag) VALUES ('Docs Needed', ?, ?, 'case', 'docs_needed')`,
          [req.auth.userId || 0, case_id]
        );
        checklist = { id: result.insertId };
      } catch (err) {
        if (!isDupTag(err)) throw err;
        // Lost a race: a concurrent upsert-items for this case inserted between
        // our SELECT and our INSERT, and uq_link_tag rejected the second row.
        // The caller wants the list, not an error — re-read the winner. Before
        // the constraint existed this race silently produced TWO docs lists.
        const [[raced]] = await req.db.query(FIND_DOCS_SQL, [case_id]);
        if (!raced) throw err;
        checklist = raced;
      }
    } else if (!checklist.tag) {
      // Self-heal a legacy untagged row so the title fallback can retire.
      // Cannot collide with uq_link_tag: the ORDER BY above prefers a tagged
      // row, so reaching this branch proves no tagged row exists for the case.
      await req.db.query(
        `UPDATE checklists SET tag = 'docs_needed' WHERE id = ? AND tag IS NULL`,
        [checklist.id]
      );
    }

    const checklistId = checklist.id;

    // Load existing items
    const [existing] = await req.db.query(
      'SELECT id, name FROM checkitems WHERE checklist_id = ?',
      [checklistId]
    );

    // For each incoming item: delete any matching existing item (first 22 chars), then insert
    for (let i = 0; i < items.length; i++) {
      const item = items[i].trim();
      const prefix = item.substring(0, 22);
      const match = existing.find(e => e.name.substring(0, 22) === prefix);
      if (match) {
        await req.db.query('DELETE FROM checkitems WHERE id = ?', [match.id]);
      }
      await req.db.query(
        'INSERT INTO checkitems (checklist_id, name, status, position) VALUES (?, ?, ?, ?)',
        [checklistId, item, 'incomplete', i + 1]
      );
    }

    await computeAndSaveStatus(req.db, checklistId);
    const result = await getChecklistWithItems(req.db, checklistId);
    res.json({ status: 'success', checklist: result });

    // ── Pipeline Slice E1 (Task 2): retained → docs on doc request ─────────
    // Post-response fire-and-forget (respond-first house rule): the FIRST doc
    // request on a freshly retained case marks the ball moving to the
    // client's court. Guarded STRICTLY to ['retained'] — this route fires
    // repeatedly across a case's whole life (263 live docs checklists, ~7
    // items each), and an unguarded advance would drag cases backwards from
    // meeting_341 to docs on every re-request. Every non-retained state
    // (intake stages during the ISS, mid-pipeline, no pipeline history)
    // skips silently inside advanceStage; a skipped/noop outcome is the
    // common case and needs no handling here. The catch is for REAL
    // failures only (lock timeout, unknown case, DB error) — alert() never
    // throws, but the trailing catch keeps this chain unable to produce an
    // unhandled rejection no matter what.
    pipelineService.advanceStage(req.db, String(case_id), 'docs', {
      onlyFrom: ['retained'],
      source: 'system',
      note: 'Doc request sent',
    }).catch((err) => {
      alert(req.db, {
        source: 'pipeline',
        kind: 'doc_request_advance_failed',
        group_key: 'pipeline:doc_request_advance',
        severity: 'warning',
        title: `retained→docs advance failed for case ${case_id}`,
        message: err.message,
        // cases.case_id is an alphanumeric varchar — it does NOT fit
        // system_alerts.ref_id (bigint), so it rides in context instead.
        context: { case_id: String(case_id), stage: 'docs', status: err.status || null },
      }).catch(() => {});
    });
  } catch (err) {
    console.error('POST /checklists/upsert-items error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to upsert items' });
  }
});

// ─── Public route ────────────────────────────────────────────────

const docsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});

// GET /api/public/docs/:caseId
router.get('/api/public/docs/:caseId', docsRateLimit, async (req, res) => {
  try {
    const { caseId } = req.params;

    // Get primary client name
    const [[primary]] = await req.db.query(
      `SELECT co.contact_fname
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
       WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
       LIMIT 1`,
      [caseId]
    );
    if (!primary) return res.status(404).json({ status: 'error', message: 'Case not found' });

    // Get incomplete items from Docs Needed checklist
    const [items] = await req.db.query(
      `SELECT ci.name
       FROM checkitems ci
       JOIN checklists cl ON ci.checklist_id = cl.id
       WHERE cl.link_type = 'case'
         AND cl.link = ?
         AND (cl.tag = 'docs_needed' OR cl.title = 'Docs Needed')
         AND ci.status = 'incomplete'
       ORDER BY ci.position ASC, ci.id ASC`,
      [caseId]
    );

    res.json({
      name: primary.contact_fname,
      items: items.map(i => i.name)
    });
  } catch (err) {
    console.error('GET /api/public/docs/:caseId error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch docs list' });
  }
});

// ─── Public upload routes ────────────────────────────────────────
 
const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,   // higher than docs GET — each file needs a link
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});
 
const notifyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many requests, please try again shortly.' }
});
 
/**
 * POST /api/public/get-upload-link
 * Body: { case_id, filename }
 *
 * Returns a Dropbox temporary upload link so the client browser
 * can upload directly — file bytes never touch our server.
 */
router.post('/api/public/get-upload-link', uploadRateLimit, async (req, res) => {
  try {
    const { case_id, filename, size } = req.body;
 
    if (!case_id || !filename) {
      return res.status(400).json({ status: 'error', message: 'case_id and filename are required' });
    }
 
    // Sanitize: public callers must not steer the Dropbox path. Strip path
    // separators and leading dots; '..' without a separator is just a filename.
    const safeFilename =
      String(filename).replace(/[\/\\]/g, '_').replace(/^\.+/, '').slice(0, 200)
      || 'upload.dat';

    // ── Server-side upload limits (parity with the authenticated portal
    // path — same ALLOWED_EXTENSIONS / MAX_FILE_SIZE, imported above).
    //
    // Honest limitation, same as the portal's: the browser POSTs bytes
    // straight to Dropbox, so this instance never sees them. Enforcement is
    // on DECLARED metadata at link issuance — the strongest gate available
    // without proxying uploads. The extension check is the real one (the
    // filename determines the Dropbox path, so a rejected extension cannot
    // land); declared size is accident/UX protection, not a security control.
    //
    // `size` is OPTIONAL here (unlike the portal, whose client always sends
    // it): older docReq.html builds in the wild post { case_id, filename }
    // only, and 400-ing those would break every live link. Validated when
    // present. public/docReq.html now sends it.
    const ext = extOf(safeFilename);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        status: 'error',
        message: 'That file type isn\u2019t accepted. Please upload PDF, Word, Excel, image, or text files.',
      });
    }
    if (size !== undefined && size !== null && size !== '') {
      const sizeNum = Number(size);
      if (!Number.isInteger(sizeNum) || sizeNum <= 0) {
        return res.status(400).json({
          status: 'error',
          message: 'size must be a positive whole number of bytes.',
        });
      }
      if (sizeNum > MAX_FILE_SIZE) {
        return res.status(400).json({
          status: 'error',
          message: 'Files must be 50 MB or smaller.',
        });
      }
    }
 
    // Upload-target ladder (services/uploadTargetService.js): the case's
    // Dropbox folder → auto-created folder → unsorted client-uploads folder.
    // A client always has a way to upload; the old "No Dropbox folder linked
    // to this case" dead end is gone. Total failure (Dropbox unreachable)
    // throws into the catch-all 500 below.
    let link;
    try {
      ({ link } = await uploadTarget.issueClientUploadLink(req.db, {
        caseId: case_id,
        filename: safeFilename,
      }));
    } catch (err) {
      if (err.code === 'CASE_NOT_FOUND') {
        return res.status(404).json({ status: 'error', message: 'Case not found' });
      }
      throw err;
    }

    res.json({ link });
  } catch (err) {
    console.error('POST /api/public/get-upload-link error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create upload link' });
  }
});
 
 
/**
 * POST /api/public/upload-complete
 * Body: { case_id, files: string[], comment?: string }
 *
 * Called after client finishes uploading. Logs the event
 * and emails the team with the file list + Dropbox link.
 */
router.post('/api/public/upload-complete', notifyRateLimit, async (req, res) => {
  try {
    const { case_id, files, comment } = req.body;
 
    if (!case_id || !files || !Array.isArray(files) || !files.length) {
      return res.status(400).json({ status: 'error', message: 'case_id and files array are required' });
    }
 
    // Normalise client input ONCE, before it reaches the email or the log.
    // Non-string array entries are coerced (a client can POST anything).
    // Caps applied silently — the true file count is kept for the headline.
    const fileCount   = files.length;
    const safeFiles   = files
      .slice(0, MAX_UPLOAD_FILES)
      .map(f => String(f ?? '').slice(0, MAX_UPLOAD_FILENAME));
    const omittedCount = fileCount - safeFiles.length;
    const safeComment = comment == null ? '' : String(comment).slice(0, MAX_UPLOAD_COMMENT);
 
    // Respond first, then handle side effects
    res.json({ status: 'success', message: 'Notification received. Thank you!' });
 
    // ── Side effects (non-blocking) ──────────────────────
 
    // Fetch case info for the email
    const [[caseRow]] = await req.db.query(
      `SELECT c.case_id, c.case_dropbox,
              COALESCE(c.case_number_full, c.case_number, c.case_id) AS case_display
       FROM cases c
       WHERE c.case_id = ?`,
      [case_id]
    );
    if (!caseRow) return; // case vanished — nothing to notify about
 
    // Get primary client name
    const [[primary]] = await req.db.query(
      `SELECT co.contact_fname, co.contact_lname, co.contact_name
       FROM contacts co
       JOIN case_relate cr ON co.contact_id = cr.case_relate_client_id
       WHERE cr.case_relate_case_id = ? AND cr.case_relate_type = 'Primary'
       LIMIT 1`,
      [case_id]
    );
    const clientName = primary?.contact_name || 'Unknown client';
 
    // Where did the batch land? Re-derived server-side — nothing trustworthy
    // travels from link issuance through the client (see uploadTargetService,
    // complete-time inspection). Null (case vanished) already handled above;
    // an inspection ERROR degrades to the legacy wording below.
    let dest = null;
    try {
      dest = await uploadTarget.inspectUploadDestination(req.db, case_id);
    } catch (e) {
      console.warn('Upload destination inspection failed:', e.message);
    }

    // Build file list for email. EVERY interpolated value is escaped: the
    // filenames and comment are attacker-controlled (public route), and the
    // DB-derived values are escaped as defence in depth — case_dropbox in
    // particular sits inside an href, where an unescaped quote breaks out of
    // the attribute.
    const fileListHtml = safeFiles.map(f => `<li>${escapeHtml(f)}</li>`).join('\n');
    const omittedHtml = omittedCount > 0
      ? `\n        <li><em>… and ${omittedCount} more file${omittedCount > 1 ? 's' : ''} not listed</em></li>`
      : '';
    const commentBlock = safeComment
      ? `<p><strong>Client comment:</strong> ${escapeHtml(safeComment)}</p>`
      : '';

    // Placement-aware Dropbox paragraph. Unsorted placement gets a loud note
    // + a staff task (below); dest === null (inspection error) degrades to
    // the legacy case_dropbox wording.
    let dropboxHtml;
    if (dest && dest.placement === 'unsorted') {
      const where = dest.link
        ? `<a href="${escapeHtml(dest.link)}">unsorted client uploads folder</a>`
        : `unsorted client uploads folder (<code>${escapeHtml(dest.path)}</code>)`;
      dropboxHtml =
        `<p><strong>Note:</strong> this case has no working Dropbox folder — the files were ` +
        `placed in the ${where}. Please move them into the case's folder.</p>`;
    } else {
      const dropboxLink = (dest && dest.sharedLink) || caseRow.case_dropbox || '';
      dropboxHtml = dropboxLink
        ? `<p><a href="${escapeHtml(dropboxLink)}">Open Dropbox Folder</a> — review, rename, and move files from the "Client Uploads" subfolder.</p>`
        : '<p><em>No Dropbox link on file for this case.</em></p>';
    }
 
    // Subject is a MIME header, not HTML — deliberately NOT escaped
    // (matches services/taskService.js convention).
    const subject = `New Documents Uploaded — ${clientName} (${caseRow.case_display})`;
    const html = `
      <p><strong>${escapeHtml(clientName)}</strong> uploaded <strong>${fileCount}</strong> document${fileCount > 1 ? 's' : ''} to case <strong>${escapeHtml(caseRow.case_display)}</strong>.</p>
 
      <p><strong>Files:</strong></p>
      <ul>
        ${fileListHtml}${omittedHtml}
      </ul>
 
      ${commentBlock}
 
      ${dropboxHtml}
    `.trim();
 
    // Recipient from app_settings — the SAME key the portal flow reads
    // (services/portalDocsService.js NOTIFY_TO_KEY), so editing the setting
    // retargets BOTH upload surfaces. Sender = the firm-wide automations
    // address (cfg('email_automations'), AUTO_EMAIL env fallback — the
    // taskService / featureRequests / auth.password convention).
    // Blank/missing recipient ⇒ email skipped with a warning (the case-log
    // entry below still writes) — deliberate staff off-switch semantics.
    let notifyTo = '';
    try {
      notifyTo = String((await getSetting(req.db, NOTIFY_TO_KEY)) ?? '').trim();
    } catch (e) {
      console.error('Upload notification settings read failed — email skipped:', e.message);
    }
    if (notifyTo) {
      emailService.sendEmail(req.db, {
        from: cfg('email_automations') || 'automations@4lsg.com',
        to:   notifyTo,
        subject,
        html
      }).catch(err => console.error('Upload notification email failed:', err.message));
    } else {
      console.warn(
        `Upload notification email skipped — ${NOTIFY_TO_KEY} unset or blank ` +
        `(blank = notifications off)`
      );
    }

    // Unsorted placement is easy to lose in an inbox — raise a staff task
    // (best-effort, self-caught in the service) so the files get moved.
    if (dest && dest.placement === 'unsorted') {
      uploadTarget.raiseUnsortedUploadTask(req.db, {
        caseId:     case_id,
        clientName,
        fileCount,
        path:       dest.path,
        link:       dest.link,
      });
    }
 
    // Log the upload event on the case
    logService.createLogEntry(req.db, {
      type:      'docs',
      link_type: 'case',
      link_id:   case_id,
      by:        0,  // system / client action
      data:      JSON.stringify({
        action:     'client_upload',
        files:      safeFiles,
        file_count: fileCount,
        comment:    safeComment || null
      }),
      subject:   `Client uploaded ${fileCount} document${fileCount > 1 ? 's' : ''}`,
      direction: 'incoming'
    }).catch(err => console.error('Upload log entry failed:', err.message));
 
  } catch (err) {
    console.error('POST /api/public/upload-complete error:', err);
    // Response already sent — just log
  }
});
module.exports = router;