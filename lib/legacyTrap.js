// Temporary fire-and-forget caller-identification logger for legacy routes
// we want to retire. Writes every inbound request to `legacy_route_log`.
// Review the table to identify callers, then delete the legacy route, remove
// the trap wiring, and finally DROP TABLE legacy_route_log + delete this file.
//
// Intentionally does NOT sanitize: we want to see plaintext creds / api keys
// in order to fingerprint which integration is calling. Keep the table access
// restricted and drop the table promptly.

function trap(label) {
  return (req, _res, next) => {
    if (req.db) {
      req.db
        .query(
          `INSERT INTO legacy_route_log
             (route, method, ip, user_agent, query_json, body_json, headers_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            label,
            req.method,
            req.ip,
            req.get('user-agent') || null,
            JSON.stringify(req.query || {}),
            JSON.stringify(req.body || {}),
            JSON.stringify(req.headers || {}),
          ]
        )
        .catch(() => {}); // log failure must never break the real route
    }
    next();
  };
}

module.exports = trap;
