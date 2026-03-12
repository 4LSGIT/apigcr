// /lib/internal_functions.js
  const ms = require('ms');


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

schedule_resume: async (params) => {
  let resumeAt;

  if (typeof params.resumeAt === 'string') {
    // Try ISO first
    const dt = new Date(params.resumeAt);
    if (!isNaN(dt.getTime())) {
      resumeAt = dt.toISOString();
    } else {
      // Try human duration ("10m", "2h", "1d 30m", "45s")
      const msDelay = ms(params.resumeAt);
      if (msDelay === undefined) {
        throw new Error(`Invalid resumeAt: "${params.resumeAt}". Use ISO or duration like "10m", "2h", "30s"`);
      }
      resumeAt = new Date(Date.now() + msDelay).toISOString();
    }
  } else if (typeof params.resumeAt === 'number') {
    // Number = milliseconds from now
    resumeAt = new Date(Date.now() + params.resumeAt).toISOString();
  } else {
    throw new Error('resumeAt must be ISO string, duration string, or number (ms)');
  }

  const nextStep = params.nextStep;
  if (nextStep == null) throw new Error('nextStep is required');

  console.log(`[SCHEDULE_RESUME] Scheduled resume at ${resumeAt} for step ${nextStep}`);

  return {
    delayed_until: resumeAt,
    nextStep
  };
},

  noop: async () => {
  console.log('[NOOP] Step executed - just setting variables via config');
  return { success: true };
}

};

module.exports = internalFunctions;