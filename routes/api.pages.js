// routes/api.pages.js
//
/**
 * Landing Pages — management API (Slice 1)
 * routes/api.pages.js
 *
 * JWT-gated CRUD (jwtOrApiKey):
 *   GET    /api/pages                  — lean list (no html column)
 *   GET    /api/pages/:id              — full row (manager preview reads html here)
 *   POST   /api/pages                  — create { slug, html, host?, path?, status?,
 *                                          hook_slug?, thankyou_url?, meta_title? }
 *   PATCH  /api/pages/:id              — partial update
 *   DELETE /api/pages/:id              — delete
 *   POST   /api/pages/:id/create-hook  — bootstrap a YisraHook for this page
 *
 * create-hook produces a hook record identical in shape to what
 * public/automation/hooks.html produces (verified against hooks.html
 * collectFilterConditions / collectMapperRules and the POST /api/hooks route):
 *   slug            = "lp-" + page slug (prefix marks provenance and avoids
 *                     clashing with hand-created hooks; length-guarded against
 *                     hooks.slug VARCHAR(100))
 *   auth_type       = 'none' (form submits call executeHook directly; auth on
 *                     the /hooks receiver is irrelevant to this path)
 *   filter_mode     = 'conditions'
 *   filter_config   = { operator:'and',
 *                       conditions:[{ path:'website', op:'not_exists', value:'' }] }
 *   transform_mode  = 'passthrough'  (transform_config = null)
 *   NO targets — those get wired in Automation → Hooks.
 *
 * Passthrough rather than a mapper: hookMapper.executeMapper REPLACES input
 * with mapped output (no merge), so any hook-level mapper would have to
 * enumerate every form field or drop the rest. Passthrough delivers the full
 * flat envelope ({...formFields, _page, _host, _ip, _referrer, _ua}) to
 * targets; per-target shaping happens in the hooks UI. The honeypot filter
 * is unaffected — runFilter evaluates against raw input pre-transform.
 *
 * Error shape: { status:'error', message } — house standard.
 * Auto-mounts via the routes/ scan in server.js.
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const pageService = require('../services/pageService');
const hookService = require('../services/hookService');

function errBody(msg) {
  return { status: 'error', message: msg };
}

// LIST (lean — no html)
router.get('/api/pages', jwtOrApiKey, async (req, res) => {
  try {
    const pages = await pageService.listPages(req.db);
    res.json({ status: 'success', pages });
  } catch (err) {
    console.error('GET /api/pages error:', err);
    res.status(500).json(errBody('Failed to list pages'));
  }
});

// GET ONE (full, including html)
router.get('/api/pages/:id', jwtOrApiKey, async (req, res) => {
  try {
    const page = await pageService.getPage(req.db, req.params.id);
    if (!page) return res.status(404).json(errBody('Page not found'));
    res.json({ status: 'success', page });
  } catch (err) {
    console.error('GET /api/pages/:id error:', err);
    res.status(500).json(errBody('Failed to fetch page'));
  }
});

// CREATE
router.post('/api/pages', jwtOrApiKey, async (req, res) => {
  try {
    const page = await pageService.createPage(req.db, req.body || {});
    res.json({ status: 'success', page });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('A page with this slug already exists'));
    }
    if (err.status === 400) return res.status(400).json(errBody(err.message));
    console.error('POST /api/pages error:', err);
    res.status(500).json(errBody('Failed to create page'));
  }
});

// UPDATE (partial)
router.patch('/api/pages/:id', jwtOrApiKey, async (req, res) => {
  try {
    const page = await pageService.updatePage(req.db, req.params.id, req.body || {});
    if (!page) return res.status(404).json(errBody('Page not found'));
    res.json({ status: 'success', page });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('A page with this slug already exists'));
    }
    if (err.status === 400) return res.status(400).json(errBody(err.message));
    console.error('PATCH /api/pages/:id error:', err);
    res.status(500).json(errBody('Failed to update page'));
  }
});

// DELETE
router.delete('/api/pages/:id', jwtOrApiKey, async (req, res) => {
  try {
    const ok = await pageService.deletePage(req.db, req.params.id);
    if (!ok) return res.status(404).json(errBody('Page not found'));
    res.json({ status: 'success' });
  } catch (err) {
    console.error('DELETE /api/pages/:id error:', err);
    res.status(500).json(errBody('Failed to delete page'));
  }
});

// CREATE-HOOK bootstrap
router.post('/api/pages/:id/create-hook', jwtOrApiKey, async (req, res) => {
  try {
    const page = await pageService.getPage(req.db, req.params.id);
    if (!page) return res.status(404).json(errBody('Page not found'));

    const hookSlug = 'lp-' + page.slug;
    if (hookSlug.length > 100) {
      return res.status(400).json(errBody(
        'Page slug too long to auto-create a hook (lp- prefix would exceed 100 chars). ' +
        'Shorten the page slug or create the hook manually.'
      ));
    }

    // Explicit collision check (covers inactive hooks too — getHookBySlug
    // filters active=1, so we go straight at the table).
    const [[existing]] = await req.db.query(
      `SELECT id, slug FROM hooks WHERE slug = ? LIMIT 1`,
      [hookSlug]
    );
    if (existing) {
      return res.status(409).json(errBody(
        `A hook with slug "${hookSlug}" already exists (hook #${existing.id}). ` +
        `Set this page's hook manually or rename one of them.`
      ));
    }

    const filter_config = {
      operator: 'and',
      conditions: [{ path: 'website', op: 'not_exists', value: '' }],
    };

    // Same column treatment as POST /api/hooks: configs JSON.stringified,
    // last_modified_by from JWT (null under api_key auth). transform_config
    // stays NULL (column default) — passthrough takes no config.
    const hookData = {
      slug: hookSlug,
      name: `Landing page: ${page.slug}`,
      description: `Auto-created for landing page "${page.slug}". Receives form submissions; add targets in Automation → Hooks.`,
      auth_type: 'none',
      filter_mode: 'conditions',
      filter_config: JSON.stringify(filter_config),
      transform_mode: 'passthrough',
      last_modified_by: req.auth && req.auth.userId != null ? req.auth.userId : null,
    };

    const hookId = await hookService.createHook(req.db, hookData);
    await pageService.updatePage(req.db, page.id, { hook_slug: hookSlug });

    const hook = await hookService.getHookById(req.db, hookId);
    res.json({ status: 'success', hook });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json(errBody('A hook with this slug already exists'));
    }
    console.error('POST /api/pages/:id/create-hook error:', err);
    res.status(500).json(errBody('Failed to create hook'));
  }
});

module.exports = router;