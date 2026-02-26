const internalFunctions = {

  set_test_var: async (params, context) => {  // optional: receive context if needed later
  console.log('[SET_TEST_VAR] Setting testKey = "hello"');
  return {
    success: true,
    set_vars: {
      testKey: "hello"   // ← must be here!
    }
  };
},

  set_next: async (params) => {
    const next = params.value; // or params.nextStep, etc. — adjust as needed
    console.log(`[SET_NEXT] Setting next step to ${next}`);

    // Return in the shape we expect in executeStep
    return {
      next_step: next,  // number, null, 'cancel', 'fail', etc.
      success: true
    };
  },

  // Optional: add schedule_resume if you want steps to trigger delays
  schedule_resume: async (params) => {
    const resumeAt = params.resumeAt; // ISO string
    const nextStep = params.nextStep;

    console.log(`[SCHEDULE_RESUME] Scheduled resume at ${resumeAt} for step ${nextStep}`);

    return {
      delayed_until: resumeAt,
      success: true
    };
  },

  noop: async () => {
  console.log('[NOOP] Step executed - just setting variables via config');
  return { success: true };
}

};

module.exports = internalFunctions;