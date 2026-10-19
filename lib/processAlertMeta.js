// Runtime identity attached to process-level alerts. These alerts may share a
// database across local development and Cloud Run, so environment is both
// visible in context and part of the group key (and therefore its throttle).

function environmentName(env = process.env) {
  const raw = env.ENVIRONMENT || env.NODE_ENV || (env.K_SERVICE ? "production" : "unknown");
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "unknown";
}

function processAlertMeta({
  env = process.env,
  pid = process.pid,
  nodeVersion = process.version,
  build = null,
} = {}) {
  const environment = environmentName(env);
  return {
    environment,
    groupKey(kind) {
      return `app:${environment}:${kind}`;
    },
    context: {
      environment,
      service: env.K_SERVICE || null,
      revision: env.K_REVISION || null,
      instance: env.HOSTNAME || null,
      build: build || env.APP_BUILD || env.K_REVISION || null,
      pid,
      node_version: nodeVersion,
    },
  };
}

module.exports = { environmentName, processAlertMeta };
