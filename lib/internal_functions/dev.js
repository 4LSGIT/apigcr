// lib/internal_functions/dev.js

const fns = {};

/**
 * set_test_var — dev/testing only. Remove or restrict in production.
 */

fns.set_test_var = async () => {
    console.log('[SET_TEST_VAR] Setting testKey = "hello"');
    return {
      success: true,
      set_vars: { testKey: 'hello' }
    };
  };

fns.set_test_var.__meta = {
  category: 'dev',
  workflowOnly: true,   // sequence exclusion is meta-driven (routes/workflows.js)
  uiHidden: true,       // dev-only: hidden from editor pickers unless already selected
  description: 'Dev/testing only. Sets testKey = "hello".',
  params: [],
  example: {}
};

module.exports = fns;