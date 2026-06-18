// Writes an audit log entry for every successful state-changing operation.
// Runs after the route handler, within the same database transaction, before commit.
// Reads req.auditContext (set by the route handler) and combines it with auth and request data.
// Scrubs prohibited fields from snapshots. If audit write fails, the entire transaction rolls back.
// Skipped for GET requests and health endpoints. See directives/middleware-architecture.md section 6.

// TODO: Read req.auditContext; skip if absent (GET requests, health checks)
// TODO: Construct audit entry from auditContext + auth context + request metadata
// TODO: Scrub prohibited fields (auth_provider_id, raw connection_config, reports.content)
// TODO: Validate all required fields per directives/audit-policy.md section 2
// TODO: Insert row into audit_logs within the current transaction
// TODO: Commit the transaction (route handler work + audit entry)

function auditContext(req, res, next) {
  next();
}

module.exports = auditContext;
