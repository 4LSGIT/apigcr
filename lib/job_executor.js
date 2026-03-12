// lib/job_executor.js
const axios = require("axios");
const vm = require("vm");
const internalFunctions = require("./internal_functions");

/**
 * Execute one job (webhook, internal_function, custom_code)
 * Used by both standalone scheduler and workflow steps
 */
async function executeJob(job) {
  let jobData;
  try {
    jobData = typeof job.data === "string" ? JSON.parse(job.data) : job.data;
  } catch (err) {
    throw new Error(`Invalid job.data JSON: ${err.message}`);
  }

  const { type } = jobData;

  if (type === "webhook") {
    const { url, method = "GET", headers = {}, body } = jobData;
    if (!url) throw new Error('Webhook job missing "url"');

    const response = await axios({
      url,
      method,
      headers,
      data: body,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    return response.data;
  }

  if (type === "internal_function") {
    const { function_name, params = {} } = jobData;
    const fn = internalFunctions[function_name];
    if (!fn) throw new Error(`Unknown internal function: ${function_name}`);
    return await fn(params);
  }

  if (type === "custom_code") {
    const { code, input = {} } = jobData;
    if (!code) throw new Error('Custom code job missing "code"');

    const sandbox = {
      input,
      console: {
        log: (...args) => console.log(`[CUSTOM CODE ${job.id}]`, ...args),
      },
    };

    const script = new vm.Script(code);
    return script.runInNewContext(sandbox, { timeout: 5000 });
  }

  throw new Error(`Unsupported job type: ${type}`);
}

module.exports = { executeJob };