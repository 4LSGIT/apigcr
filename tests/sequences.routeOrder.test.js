/**
 * tests/sequences.routeOrder.test.js
 *
 * Pins the registration order of the sequence step routes.
 *
 * WHY THIS EXISTS
 * Express matches router layers in registration order; the first match wins.
 * PATCH /sequences/templates/:id/steps/:stepNumber happily captures the
 * literal path segment 'reorder', so if the reorder route is registered
 * after it, every reorder request lands in the :stepNumber handler, matches
 * no updatable field, and 400s with "Nothing to update". That is exactly
 * what shipped: sequence step reorder was dead in production from day one
 * (found in the 2026-08-18 automation-versioning plan review). Same class
 * of bug as the /d/:token/respond ordering fix on the landing host.
 *
 * Two assertions, both against the REAL router object (not source text):
 *   1. layer order — the reorder layer index precedes the PATCH :stepNumber
 *      layer index in router.stack.
 *   2. empirical match — Express's own path-matching resolves
 *      PATCH .../steps/reorder to the reorder layer, not :stepNumber.
 *
 *   npx jest tests/sequences.routeOrder.test.js
 */

const router = require('../routes/sequences');

function layersFor(method) {
  return router.stack
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) =>
      layer.route &&
      layer.route.methods &&
      layer.route.methods[method]
    );
}

describe('routes/sequences.js — step route registration order', () => {
  test('reorder is registered before PATCH :stepNumber', () => {
    const patches = layersFor('patch');
    const reorder = patches.find(({ layer }) =>
      layer.route.path === '/sequences/templates/:id/steps/reorder');
    const byNumber = patches.find(({ layer }) =>
      layer.route.path === '/sequences/templates/:id/steps/:stepNumber');

    expect(reorder).toBeDefined();
    expect(byNumber).toBeDefined();
    expect(reorder.index).toBeLessThan(byNumber.index);
  });

  test("Express resolves PATCH .../steps/reorder to the reorder layer, not :stepNumber", () => {
    const path = '/sequences/templates/12/steps/reorder';
    const patches = layersFor('patch');

    // Walk layers in stack order the way Express does; first regexp match wins.
    const winner = patches.find(({ layer }) => layer.regexp.test(path));

    expect(winner).toBeDefined();
    expect(winner.layer.route.path).toBe('/sequences/templates/:id/steps/reorder');
  });

  test('workflows router keeps the same invariant (guards against copy-paste regressions)', () => {
    const wfRouter = require('../routes/workflows');
    const patches = wfRouter.stack
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.route && layer.route.methods && layer.route.methods.patch);

    const reorder = patches.find(({ layer }) => /steps\/reorder$/.test(layer.route.path));
    const byNumber = patches.find(({ layer }) => /steps\/:step/.test(layer.route.path));

    // workflows.js has always had this right (reorder :1406 before :stepNumber
    // :1776 pre-fix numbering); pin it so it stays right.
    expect(reorder).toBeDefined();
    expect(byNumber).toBeDefined();
    expect(reorder.index).toBeLessThan(byNumber.index);
  });
});
